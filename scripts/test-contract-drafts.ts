/**
 * Test modułu Drafty umów (/api/contracts/drafts) — przez trasy Hono
 * (app.request) z podstawionym userem i strażnikiem uprawnień, na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-contract-drafts.ts
 *
 * Sprawdza: kwotę słownie (odmiana złoty/złote/złotych, grosze), listę szablonów
 * z flagą `available` wg spółki obiektu i metadanymi wzoru (plik, rozmiar,
 * liczba pól, źródło, licznik draftów), pobranie PUSTEGO wzoru (kropki zamiast
 * wartości, zero nawiasów klamrowych) i surowego pliku z `{tagami}`,
 * prefill z kartoteki (abonament, NIP,
 * miejscownik adresu, osoby kontaktowe, źródła), zapis draftu razem z RENDEREM
 * DOCX (numer, adres i kwota słownie w wygenerowanym pliku, zero nawiasów
 * klamrowych), numerację per spółka i rok wraz z unikalnym indeksem, komunikaty
 * 400 przy braku spółki i kodu, flagę `stale` po edycji i po ponownej generacji,
 * kropki w miejscu pustych kontaktów, pobieranie pliku, załączniki, uprawnienia
 * i kasowanie obiektu razem z katalogiem draftów.
 *
 * Sprząta po sobie HARD (wiersze + katalogi + activity_log + fikstury), także
 * przy błędzie.
 */
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import PizZip from "pizzip";
import sharp from "sharp";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import contractDraftsRoutes from "../src/routes/contract-drafts.js";
import contractsRoutes from "../src/routes/contracts.js";
import objectsRoutes from "../src/routes/objects.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import { ATTACHMENTS_DIR, removeAttachmentDir, resolveStoredPath } from "../src/lib/calendar-attachments.js";
import { kwotaSlownie, liczbaSlownie } from "../src/lib/kwota-slownie.js";
import { formatContractNumber } from "../src/lib/contract-numbering.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__CDRAFT_TEST__";
const BASE = "/contracts/drafts";
const TEMPLATE = "zdw-alfa-group";
/** Placeholder pustej osoby kontaktowej z oryginalnego wzoru: 5 × „…" + kropka. */
const KROPKI = "\u2026".repeat(5) + ".";
const YEAR = 2026;
const DATE = `${YEAR}-01-07`;

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const plain = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !plain) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");

function withPerms(user: User, permissions: Record<string, "view" | "edit">): User {
  return { ...user, role: "user", permissions: JSON.stringify(permissions) };
}

// ---------------------------------------------------------------------------
// Sprzątanie
// ---------------------------------------------------------------------------

function cleanup(): number {
  const objectIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const companyIds = db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(like(schema.companies.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);

  const draftIds = db
    .select()
    .from(schema.contractDrafts)
    .all()
    .filter((d) => objectIds.includes(d.objectId) || companyIds.includes(d.companyId))
    .map((d) => d.id);

  for (const id of draftIds) removeAttachmentDir(`contract-drafts/${id}`);
  if (draftIds.length) {
    db.delete(schema.contractDrafts).where(inArray(schema.contractDrafts.id, draftIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "contract_draft"), inArray(schema.activityLog.entityId, draftIds)))
      .run();
  }
  if (objectIds.length) {
    db.delete(schema.contacts).where(inArray(schema.contacts.objectId, objectIds)).run();
    db.delete(schema.objects).where(inArray(schema.objects.id, objectIds)).run();
  }
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  if (companyIds.length) {
    db.delete(schema.companies).where(inArray(schema.companies.id, companyIds)).run();
  }
  return draftIds.length;
}
cleanup();

// ---------------------------------------------------------------------------
// Aplikacja testowa (strażnik zakładek + routery, jak w src/routes/index.ts)
// ---------------------------------------------------------------------------

function appFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // Hono bez generyka `Variables` typuje klucz jako `never` — w produkcji ustawia
    // go requireAuth, tutaj podstawiamy usera wprost.
    c.set("user" as never, user as never);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route(BASE, contractDraftsRoutes);
  // Rejestr umów montujemy PO draftach — dokładnie jak src/routes/index.ts,
  // inaczej `/contracts/drafts` wpadłoby w `/contracts/:id`.
  app.route("/contracts", contractsRoutes);
  app.route("/objects", objectsRoutes);
  return app;
}
const asAdmin = appFor(admin);
const asEditor = appFor(withPerms(plain, { contracts: "edit" }));
const asViewer = appFor(withPerms(plain, { contracts: "view" }));
const asStranger = appFor(withPerms(plain, { orders: "edit" }));

type Resp<T> = { success: boolean; data?: T; error?: string };
type AttJson = { id: number; fileName: string; mimeType: string; size: number; kind: string; url: string; downloadUrl: string };
type DraftJson = {
  id: number;
  objectId: number;
  objectName: string;
  contractorId: number | null;
  contractorName: string | null;
  companyId: number;
  companyName: string;
  templateKey: string;
  templateLabel: string;
  contractNumber: string;
  seq: number;
  year: number;
  contractDate: string;
  status: string;
  statusLabel: string;
  fields: Record<string, string>;
  notes: string | null;
  generatedFileName: string | null;
  generatedAt: string | null;
  fileUrl: string | null;
  stale: boolean;
  registryContractId: number | null;
  attachments: AttJson[];
  createdBy: number | null;
  createdByLabel: string | null;
};
/** Odpowiedź „Przenieś do rejestru”: nowy wiersz rejestru + draft po zmianie. */
type PromoteJson = {
  contract: {
    id: number;
    objectId: number;
    contractNumber: string;
    startDate: string;
    value: number | null;
    status: string;
    draftId: number | null;
    draftFileUrl: string | null;
  };
  draft: DraftJson;
};
type TemplateJson = {
  key: string;
  label: string;
  companyId: number | null;
  companyName: string;
  available: boolean;
  warning: string | null;
  groups: string[];
  sourceNote: string;
  fileName: string;
  fileSize: number;
  fieldCount: number;
  draftCount: number;
  fields: { key: string; label: string; group: string; type: string; required: boolean; readOnly: boolean; emptyPlaceholder: string | null; derivedFrom: string | null }[];
};
type PrefillJson = {
  template: TemplateJson;
  fields: Record<string, string>;
  sources: Record<string, string>;
  warnings: string[];
  numberPreview: string;
  companyId: number | null;
  companyName: string | null;
  contractorId: number | null;
  contractorName: string | null;
  objectName: string;
  contractDate: string;
};

/**
 * Adres trasy. Router jest zamontowany pod BASE, więc trasa `/` to DOKŁADNIE
 * BASE — Hono chodzi w trybie strict i `/contracts/drafts/` (z ukośnikiem na
 * końcu) byłoby 404.
 */
function url(path: string): string {
  if (path === "/") return BASE;
  if (path.startsWith("/?")) return BASE + path.slice(1);
  return BASE + path;
}

/** Odpowiedź jako JSON; przy błędzie routingu (goły tekst) zwracamy treść jako error. */
async function asJson<T>(res: Response): Promise<Resp<T>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Resp<T>;
  } catch {
    return { success: false, error: text };
  }
}

async function get<T>(app: Hono, path: string): Promise<{ status: number; json: Resp<T> }> {
  const res = await app.request(url(path));
  return { status: res.status, json: await asJson<T>(res) };
}
async function send<T>(app: Hono, method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const res = await app.request(url(path), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return { status: res.status, json: await asJson<T>(res) };
}
async function upload<T>(app: Hono, path: string, files: { name: string; type: string; data: Buffer }[]) {
  const fd = new FormData();
  for (const f of files) fd.append("files", new File([new Uint8Array(f.data)], f.name, { type: f.type }));
  const res = await app.request(url(path), { method: "POST", body: fd });
  return { status: res.status, json: await asJson<T>(res) };
}

/** Tekst `word/document.xml` z wygenerowanego pliku draftu. */
function documentXml(storedPath: string): string {
  const abs = resolveStoredPath(storedPath)!;
  return new PizZip(readFileSync(abs)).file("word/document.xml")!.asText();
}

function storedPathOf(draftId: number): string {
  return db.select().from(schema.contractDrafts).where(eq(schema.contractDrafts.id, draftId)).get()!.generatedStoredPath!;
}

// ---------------------------------------------------------------------------
// Fikstury
// ---------------------------------------------------------------------------

const contractor = db
  .insert(schema.contractors)
  .values({
    name: `${PREFIX} Kontrahent`,
    // NIP spoza kartoteki (kolumna jest UNIQUE) — testowa wartość, nie realny podatnik.
    nip: "9999999990",
    address: "ul. Heroldów 7",
    postalCode: "01-991",
    city: "Warszawa",
    email: "biuro@cdraft.invalid",
    contactPerson: "Michał Pawlak",
  })
  .returning()
  .get();

const companyValues = (name: string, code: string | null) => ({
  name,
  fullName: `${name} SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ`,
  nip: "6931836206",
  regon: "390651040",
  krs: "0000119104",
  address: "Koniczynowa 2a",
  postalCode: "03-612",
  city: "Warszawa",
  contractCode: code,
  contractName: code ? `${name} Sp. z o.o.` : null,
  representativeLine: code ? "Jana Kowalskiego - Prezesa Zarządu" : null,
  shareCapital: code ? "50 000,00 zł" : null,
});
const coA = db.insert(schema.companies).values(companyValues(`${PREFIX} SPOLKA A`, "TST")).returning().get();
const coB = db.insert(schema.companies).values(companyValues(`${PREFIX} SPOLKA B`, "TS2")).returning().get();
const coNoCode = db.insert(schema.companies).values(companyValues(`${PREFIX} BEZ KODU`, null)).returning().get();

const objectValues = (name: string, companyId: number | null, monthlyZdw: number | null) => ({
  contractorId: contractor.id,
  companyId,
  name,
  address: "Testowa 1",
  city: "Warszawa",
  monthlyZdw,
  type: "monitoring" as const,
  installationType: "new" as const,
});
const objA = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt A`, coA.id, 1900)).returning().get();
const objB = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt B`, coB.id, 250.5)).returning().get();
const objNoCompany = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt bez spolki`, null, 100)).returning().get();
const objNoCode = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt bez kodu`, coNoCode.id, 100)).returning().get();
const objDel = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt do kasacji`, coA.id, 300)).returning().get();

// Osoba kontaktowa TYLKO na obiekcie A — obiekt B zostaje bez kontaktów (test kropek).
db.insert(schema.contacts)
  .values({
    objectId: objA.id,
    firstName: "Anna",
    lastName: "Nowak",
    phone: "600 100 200",
    email: "a.nowak@cdraft.invalid",
    active: true,
  })
  .run();

const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 90, b: 160 } } })
  .png()
  .toBuffer();

try {
  // ======================================================== 1. KWOTA SŁOWNIE
  const slownie: [number, string][] = [
    [0, "zero złotych"],
    [1, "jeden złoty"],
    [2, "dwa złote"],
    [5, "pięć złotych"],
    [21, "dwadzieścia jeden złotych"],
    [22, "dwadzieścia dwa złote"],
    [150, "sto pięćdziesiąt złotych"],
    [1900, "jeden tysiąc dziewięćset złotych"],
    [1234.56, "jeden tysiąc dwieście trzydzieści cztery złote 56/100"],
    [1_000_000, "jeden milion złotych"],
  ];
  for (const [n, expected] of slownie) {
    ok(`kwotaSlownie(${n}) = „${expected}”`, kwotaSlownie(n) === expected, kwotaSlownie(n));
  }
  ok("liczbaSlownie(1900) bez rzeczownika", liczbaSlownie(1900) === "jeden tysiąc dziewięćset", liczbaSlownie(1900));
  ok("kwotaSlownie zaokrągla grosze", kwotaSlownie(0.005) === "zero złotych 01/100", kwotaSlownie(0.005));

  // ======================================================== 2. SZABLONY
  const tplNoObject = await get<{ items: TemplateJson[] }>(asEditor, "/templates");
  const tpl0 = tplNoObject.json.data?.items[0];
  ok(
    "GET /templates bez objectId → szablon ZDW dostępny, z grupami i polami",
    tplNoObject.status === 200 && tpl0?.key === TEMPLATE && tpl0.available === true && tpl0.warning === null,
    tplNoObject.json
  );
  ok(
    "GET /templates: grupy DOKŁADNIE jak w kontrakcie",
    tpl0?.groups.join("|") ===
      ["Nagłówek umowy", "Zleceniobiorca (spółka)", "Zleceniodawca (kontrahent)", "Obiekt", "Rozliczenie", "Osoby kontaktowe Zleceniodawcy"].join("|"),
    tpl0?.groups
  );
  ok("GET /templates: 29 pól, każde z grupą z listy", tpl0?.fields.length === 29 && tpl0.fields.every((f) => tpl0.groups.includes(f.group)), tpl0?.fields.length);
  ok(
    "GET /templates: `numer` readOnly, `kontakt1_nazwa` z kropkami, `abonament_slownie` derivedFrom",
    tpl0?.fields.find((f) => f.key === "numer")?.readOnly === true &&
      tpl0?.fields.find((f) => f.key === "kontakt1_nazwa")?.emptyPlaceholder === KROPKI &&
      tpl0?.fields.find((f) => f.key === "abonament_slownie")?.derivedFrom === "abonament",
    tpl0?.fields.filter((f) => ["numer", "kontakt1_nazwa", "abonament_slownie"].includes(f.key))
  );

  ok(
    "GET /templates: metadane wzoru (plik, rozmiar, liczba pól, źródło)",
    tpl0?.fileName === "zdw-alfa-group.docx" &&
      (tpl0?.fileSize ?? 0) > 1000 &&
      tpl0?.fieldCount === tpl0?.fields.length &&
      /Aktualna Umowa Draft Tylko ZDW\.docx/.test(tpl0?.sourceNote ?? ""),
    { fileName: tpl0?.fileName, fileSize: tpl0?.fileSize, fieldCount: tpl0?.fieldCount, sourceNote: tpl0?.sourceNote }
  );
  const draftCountBefore = tpl0?.draftCount ?? -1;
  ok("GET /templates: draftCount jest liczbą", Number.isInteger(draftCountBefore) && draftCountBefore >= 0, draftCountBefore);

  // Pusty wzór do podglądu: ten sam render, tylko bez wartości.
  const blank = await asEditor.request(`${BASE}/templates/${TEMPLATE}/file`);
  const blankCd = blank.headers.get("content-disposition") ?? "";
  ok(
    "GET /templates/:key/file → 200, MIME docx, załącznik „Wzór - Umowa ZDW.docx”",
    blank.status === 200 &&
      blank.headers.get("content-type") === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      /^attachment;/.test(blankCd) &&
      blankCd.includes(encodeURIComponent("Wzór - Umowa ZDW.docx")),
    { ct: blank.headers.get("content-type"), cd: blankCd }
  );
  const blankXml = new PizZip(Buffer.from(await blank.arrayBuffer())).file("word/document.xml")!.asText();
  ok("GET /templates/:key/file (blank): puste pola wyszły kropkami", blankXml.includes(KROPKI), null);
  ok("GET /templates/:key/file (blank): żadnych nawiasów klamrowych", !/[{}]/.test(blankXml), blankXml.match(/[{}][^<]{0,20}/g)?.slice(0, 5));

  // Surowy plik z tagami — dla administratora, do porównania z oryginałem.
  const tagged = await asEditor.request(`${BASE}/templates/${TEMPLATE}/file?mode=tagged`);
  const taggedXml = new PizZip(Buffer.from(await tagged.arrayBuffer())).file("word/document.xml")!.asText();
  ok("GET /templates/:key/file?mode=tagged: surowy wzór z {tagami}", tagged.status === 200 && taggedXml.includes("{numer}"), tagged.status);

  const blankBad = await asEditor.request(`${BASE}/templates/nie-ma-takiego/file`);
  ok("GET /templates/:key/file nieznanego wzoru → 404 PL", blankBad.status === 404 && (await blankBad.json()).error === "Nieznany szablon umowy", blankBad.status);
  const blankBadMode = await asEditor.request(`${BASE}/templates/${TEMPLATE}/file?mode=cokolwiek`);
  ok("GET /templates/:key/file?mode= nieznanego → 400 PL", blankBadMode.status === 400, blankBadMode.status);
  const blankStranger = await asStranger.request(`${BASE}/templates/${TEMPLATE}/file`);
  ok("bez klucza `contracts`: pobranie wzoru → 403", blankStranger.status === 403, blankStranger.status);

  const tplForA = await get<{ items: TemplateJson[] }>(asEditor, `/templates?objectId=${objA.id}`);
  ok(
    "GET /templates?objectId= dla obcej spółki → available=false z polskim ostrzeżeniem",
    tplForA.json.data?.items[0].available === false &&
      (tplForA.json.data.items[0].warning ?? "").includes(coA.name) &&
      (tplForA.json.data.items[0].warning ?? "").includes("ALFA"),
    tplForA.json.data?.items[0].warning
  );
  const tplNoCompany = await get<{ items: TemplateJson[] }>(asEditor, `/templates?objectId=${objNoCompany.id}`);
  ok(
    "GET /templates?objectId= dla obiektu bez spółki → available=false",
    tplNoCompany.json.data?.items[0].available === false &&
      /nie ma przypisanej spółki/.test(tplNoCompany.json.data.items[0].warning ?? ""),
    tplNoCompany.json.data?.items[0].warning
  );
  const tplBadObject = await get<unknown>(asEditor, "/templates?objectId=99999999");
  ok("GET /templates?objectId= nieistniejącego obiektu → 404", tplBadObject.status === 404, tplBadObject.json);

  // ======================================================== 3. PREFILL
  const pre = await get<PrefillJson>(asEditor, `/prefill?objectId=${objA.id}&template=${TEMPLATE}`);
  const p = pre.json.data!;
  ok("GET /prefill → 200 z kompletem sekcji", pre.status === 200 && !!p.template && !!p.fields && Array.isArray(p.warnings), pre.json);
  ok("prefill: abonament z obiektu jako „1900”", p.fields.abonament === "1900" && p.sources.abonament === "obiekt", { v: p.fields.abonament, s: p.sources.abonament });
  ok("prefill: abonament słownie wyliczony", p.fields.abonament_slownie === "jeden tysiąc dziewięćset złotych" && p.sources.abonament_slownie === "wyliczone", p.fields.abonament_slownie);
  ok("prefill: NIP kontrahenta sformatowany", p.fields.kontrahent_nip === "999-999-99-90" && p.sources.kontrahent_nip === "kontrahent", p.fields.kontrahent_nip);
  ok("prefill: adres obiektu w miejscowniku", p.fields.obiekt_adres === "Testowa 1 w Warszawie" && p.sources.obiekt_adres === "obiekt", p.fields.obiekt_adres);
  ok("prefill: miejsce zawarcia z miasta spółki", p.fields.miejsce === "Warszawie" && p.sources.miejsce === "spółka", p.fields.miejsce);
  ok("prefill: siedziba spółki z kodem i ulicą", p.fields.zleceniobiorca_siedziba === "Warszawie (03-612) przy ul. Koniczynowa 2a", p.fields.zleceniobiorca_siedziba);
  ok(
    "prefill: pierwsza osoba kontaktowa obiektu",
    p.fields.kontakt1_nazwa === "Anna Nowak" && p.fields.kontakt1_telefon === "600 100 200" && p.sources.kontakt1_email === "kontakt obiektu",
    { n: p.fields.kontakt1_nazwa, t: p.fields.kontakt1_telefon }
  );
  ok("prefill: druga osoba pusta (brak kontaktu)", p.fields.kontakt2_nazwa === "" && p.fields.kontakt2_email === "", p.fields.kontakt2_nazwa);
  ok("prefill: stawka patrolu domyślnie 150 + słownie", p.fields.stawka_patrol === "150" && p.fields.stawka_patrol_slownie === "sto pięćdziesiąt złotych", p.fields.stawka_patrol);
  ok("prefill: warianty domyślnie „nie jest”", p.fields.ochrona_obowiazkowa === "nie jest" && p.fields.duzy_przedsiebiorca === "nie jest", p.fields.ochrona_obowiazkowa);
  ok("prefill: podgląd numeru 1/TST/2026 przy dacie z dziś", /^1\/TST\/\d{4}$/.test(p.numberPreview) && p.fields.numer === p.numberPreview, p.numberPreview);
  ok("prefill: kontekst obiektu (spółka, kontrahent, nazwa)", p.companyId === coA.id && p.contractorId === contractor.id && p.objectName === objA.name, { c: p.companyId, k: p.contractorId });
  ok("prefill: data zawarcia w formacie RRRR-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(p.contractDate) && p.fields.data_umowy === p.contractDate, p.contractDate);

  const preBadTpl = await get<unknown>(asEditor, `/prefill?objectId=${objA.id}&template=nie-ma`);
  ok("GET /prefill z nieznanym szablonem → 400 PL", preBadTpl.status === 400 && preBadTpl.json.error === "Nieznany szablon umowy", preBadTpl.json);
  const preNoObject = await get<unknown>(asEditor, `/prefill?template=${TEMPLATE}`);
  ok("GET /prefill bez obiektu → 400 PL", preNoObject.status === 400 && preNoObject.json.error === "Nie wskazano obiektu", preNoObject.json);

  const preNoContacts = await get<PrefillJson>(asEditor, `/prefill?objectId=${objB.id}&template=${TEMPLATE}`);
  ok(
    "prefill obiektu bez kontaktów → ostrzeżenie po polsku",
    preNoContacts.json.data!.warnings.some((w) => /osób kontaktowych/.test(w)),
    preNoContacts.json.data?.warnings
  );
  ok("prefill: kwota niecałkowita jako „250.50”", preNoContacts.json.data!.fields.abonament === "250.50", preNoContacts.json.data?.fields.abonament);

  // ======================================================== 4. ZAPIS + RENDER
  const created = await send<DraftJson>(asEditor, "POST", "/", {
    objectId: objA.id,
    templateKey: TEMPLATE,
    contractDate: DATE,
    fields: { ...p.fields, numer: "PODSZYWKA" },
    notes: "pierwszy draft",
  });
  const d1 = created.json.data!;
  ok(
    "POST / → 201 z numerem 1/TST/2026 nadanym przez serwer",
    created.status === 201 && d1?.contractNumber === formatContractNumber({ seq: 1, companyCode: "TST", year: YEAR }) && d1.seq === 1 && d1.year === YEAR,
    created.json
  );
  ok("POST /: numer w polach nadpisany (formularz nie może go podać)", d1.fields.numer === d1.contractNumber, d1.fields.numer);
  ok("POST /: status domyślnie „Szkic”, snapshot kontrahenta i spółki", d1.status === "draft" && d1.statusLabel === "Szkic" && d1.contractorId === contractor.id && d1.companyId === coA.id, d1);
  ok("POST /: plik wygenerowany od razu (nazwa, URL, świeżość)", d1.generatedFileName === "Umowa ZDW 1-TST-2026.docx" && d1.fileUrl === `/api/contracts/drafts/${d1.id}/file` && d1.stale === false, {
    n: d1.generatedFileName,
    u: d1.fileUrl,
    s: d1.stale,
  });
  ok("POST /: autor podpisany", d1.createdBy === plain.id && !!d1.createdByLabel, { by: d1.createdBy, label: d1.createdByLabel });

  const sp1 = storedPathOf(d1.id);
  ok("POST /: plik leży w contract-drafts/<id>/", sp1.startsWith(`contract-drafts/${d1.id}/`) && existsSync(resolveStoredPath(sp1)!), sp1);
  const xml1 = documentXml(sp1);
  ok("render: numer umowy w document.xml", xml1.includes("1/TST/2026"), null);
  ok("render: data w formacie DD.MM.RRRR", xml1.includes("07.01.2026") && !xml1.includes("2026-01-07"), null);
  ok("render: adres obiektu i kwota słownie", xml1.includes("Testowa 1 w Warszawie") && xml1.includes("jeden tysiąc dziewięćset złotych"), null);
  ok("render: abonament bez separatorów tysięcy", xml1.includes(">1900<") || xml1.includes("1900 zł") || xml1.includes("1900"), null);
  ok("render: ŻADNEGO nawiasu klamrowego w document.xml", !/[{}]/.test(xml1), xml1.match(/.{0,30}[{}].{0,30}/g)?.slice(0, 3));
  ok("render: nazwa kontrahenta z kartoteki", xml1.includes(`${PREFIX} Kontrahent`), null);

  const badField = await send<unknown>(asEditor, "POST", "/", {
    objectId: objA.id,
    templateKey: TEMPLATE,
    fields: { nie_ma_takiego: "x" },
  });
  ok("POST / z nieznanym kluczem pola → 400 PL", badField.status === 400 && badField.json.error === "Nieznane pole formularza: nie_ma_takiego", badField.json);
  const badTemplate = await send<unknown>(asEditor, "POST", "/", { objectId: objA.id, templateKey: "nie-ma", fields: {} });
  ok("POST / z nieznanym szablonem → 400 PL", badTemplate.status === 400 && badTemplate.json.error === "Nieznany szablon umowy", badTemplate.json);
  const badDate = await send<unknown>(asEditor, "POST", "/", { objectId: objA.id, templateKey: TEMPLATE, contractDate: "07.01.2026", fields: {} });
  ok("POST / ze złym formatem daty → 400 PL", badDate.status === 400 && /RRRR-MM-DD/.test(badDate.json.error ?? ""), badDate.json);

  // Serwer sam dolicza „słownie”, gdy pole zostało puste.
  const derived = await send<DraftJson>(asEditor, "POST", "/", {
    objectId: objA.id,
    templateKey: TEMPLATE,
    contractDate: DATE,
    fields: { ...p.fields, abonament: "2500", abonament_slownie: "" },
  });
  ok(
    "POST /: puste „słownie” dolicza serwer",
    derived.json.data?.fields.abonament_slownie === "dwa tysiące pięćset złotych",
    derived.json.data?.fields.abonament_slownie
  );

  const tplAfter = await get<{ items: TemplateJson[] }>(asEditor, "/templates");
  ok(
    "GET /templates: draftCount urósł po zapisie draftu",
    (tplAfter.json.data?.items[0].draftCount ?? -1) > draftCountBefore,
    { przed: draftCountBefore, po: tplAfter.json.data?.items[0].draftCount }
  );

  // ======================================================== 5. NUMERACJA
  ok("numeracja: drugi draft tej spółki i roku → seq 2", derived.json.data?.seq === 2 && derived.json.data.contractNumber === "2/TST/2026", derived.json.data?.contractNumber);

  const otherCompany = await send<DraftJson>(asEditor, "POST", "/", { objectId: objB.id, templateKey: TEMPLATE, contractDate: DATE, fields: {} });
  ok("numeracja: inna spółka ma własny licznik → 1/TS2/2026", otherCompany.json.data?.contractNumber === "1/TS2/2026", otherCompany.json.data?.contractNumber);

  const otherYear = await send<DraftJson>(asEditor, "POST", "/", { objectId: objA.id, templateKey: TEMPLATE, contractDate: "2027-03-01", fields: {} });
  ok("numeracja: nowy rok zeruje licznik → 1/TST/2027", otherYear.json.data?.contractNumber === "1/TST/2027" && otherYear.json.data.year === 2027, otherYear.json.data?.contractNumber);

  let duplicateThrew = false;
  try {
    db.insert(schema.contractDrafts)
      .values({
        objectId: objA.id,
        contractorId: contractor.id,
        companyId: coA.id,
        templateKey: TEMPLATE,
        contractNumber: "1-BIS/TST/2026",
        seq: 1,
        year: YEAR,
        contractDate: DATE,
        fields: "{}",
      })
      .run();
  } catch {
    duplicateThrew = true;
  }
  ok("numeracja: UNIQUE (spółka, rok, seq) blokuje duplikat przy surowym INSERT", duplicateThrew);

  let duplicateNumberThrew = false;
  try {
    db.insert(schema.contractDrafts)
      .values({
        objectId: objA.id,
        contractorId: contractor.id,
        companyId: coA.id,
        templateKey: TEMPLATE,
        contractNumber: "1/TST/2026",
        seq: 99,
        year: YEAR,
        contractDate: DATE,
        fields: "{}",
      })
      .run();
  } catch {
    duplicateNumberThrew = true;
  }
  ok("numeracja: UNIQUE (contract_number) blokuje duplikat numeru", duplicateNumberThrew);

  // ======================================================== 6. BŁĘDY SPÓŁKI
  const noCompany = await send<unknown>(asEditor, "POST", "/", { objectId: objNoCompany.id, templateKey: TEMPLATE, fields: {} });
  ok(
    "POST / dla obiektu bez spółki → 400 PL",
    noCompany.status === 400 && /nie ma przypisanej spółki/.test(noCompany.json.error ?? ""),
    noCompany.json
  );
  const noCode = await send<unknown>(asEditor, "POST", "/", { objectId: objNoCode.id, templateKey: TEMPLATE, fields: {} });
  ok(
    "POST / dla spółki bez kodu numeracji → 400 z podpowiedzią „Spółki → Dane do umów”",
    noCode.status === 400 && /kod do numeracji umów w Spółki → Dane do umów/.test(noCode.json.error ?? ""),
    noCode.json
  );

  // ======================================================== 7. EDYCJA I REGENERACJA
  const edited = await send<DraftJson>(asEditor, "PUT", `/${d1.id}`, {
    fields: { ...d1.fields, abonament: "2100", abonament_slownie: "" },
    status: "sent",
    notes: "po korekcie",
  });
  ok(
    "PUT /:id → zmienione pola, status i notatka; plik oznaczony jako nieaktualny",
    edited.status === 200 && edited.json.data?.fields.abonament === "2100" && edited.json.data.stale === true && edited.json.data.statusLabel === "Wysłana do klienta",
    edited.json
  );
  ok("PUT /:id: puste „słownie” doliczone od nowa", edited.json.data?.fields.abonament_slownie === "dwa tysiące sto złotych", edited.json.data?.fields.abonament_slownie);
  ok("PUT /:id: numer NIE do ruszenia z formularza", edited.json.data?.fields.numer === d1.contractNumber, edited.json.data?.fields.numer);
  const movedObject = await send<unknown>(asEditor, "PUT", `/${d1.id}`, { objectId: objB.id });
  ok("PUT /:id ze zmianą obiektu → 400 PL", movedObject.status === 400 && /nie da się zmienić/.test(movedObject.json.error ?? ""), movedObject.json);
  const movedTemplate = await send<unknown>(asEditor, "PUT", `/${d1.id}`, { templateKey: TEMPLATE });
  ok("PUT /:id ze zmianą szablonu → 400 PL", movedTemplate.status === 400, movedTemplate.json);

  const oldPath = storedPathOf(d1.id);
  const regenerated = await send<DraftJson>(asEditor, "POST", `/${d1.id}/generate`);
  const newPath = storedPathOf(d1.id);
  ok("POST /:id/generate → stale=false, nowy plik", regenerated.status === 200 && regenerated.json.data?.stale === false && newPath !== oldPath, {
    stale: regenerated.json.data?.stale,
    old: oldPath,
    now: newPath,
  });
  ok("POST /:id/generate: stary plik usunięty, nowy istnieje", !existsSync(resolveStoredPath(oldPath)!) && existsSync(resolveStoredPath(newPath)!), { oldPath, newPath });
  ok("POST /:id/generate: nowa kwota w dokumencie", documentXml(newPath).includes("dwa tysiące sto złotych"), null);

  // ======================================================== 8. PUSTE KONTAKTY → KROPKI
  const spNoContacts = storedPathOf(otherCompany.json.data!.id);
  const xmlNoContacts = documentXml(spNoContacts);
  ok("render bez osób kontaktowych → w dokumencie zostają kropki", xmlNoContacts.includes(KROPKI), null);
  ok("render bez osób kontaktowych → żadnych nawiasów klamrowych", !/[{}]/.test(xmlNoContacts), null);

  // ======================================================== 9. POBRANIE PLIKU
  const file = await asEditor.request(`${BASE}/${d1.id}/file`);
  const cd = file.headers.get("content-disposition") ?? "";
  ok(
    "GET /:id/file → 200, MIME docx, Content-Disposition attachment",
    file.status === 200 &&
      file.headers.get("content-type") === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      /^attachment;/.test(cd),
    { ct: file.headers.get("content-type"), cd }
  );
  ok("GET /:id/file: nazwa pliku bez ukośnika z numeru", cd.includes("Umowa ZDW 1-TST-2026.docx") && !/filename="[^"]*\//.test(cd), cd);
  const fileBody = Buffer.from(await file.arrayBuffer());
  ok("GET /:id/file: treść to poprawny zip DOCX", fileBody.subarray(0, 2).toString() === "PK" && !!new PizZip(fileBody).file("word/document.xml"), fileBody.length);
  const fileMissing = await asEditor.request(`${BASE}/99999999/file`);
  ok("GET /:id/file nieistniejącego draftu → 404", fileMissing.status === 404);

  // ======================================================== 9b. PODGLĄD Z KOLORAMI (preview=1)
  // Kolory są POMOCĄ NA EKRANIE, nie częścią umowy: plik na dysku i zwykłe
  // pobranie muszą zostać bez pastelowego tła pól.
  //
  // Tło robi `w:shd w:fill` (pastele), a nie `w:highlight` — ten przyjmuje tylko
  // nazwy z listy Worda i docx-preview maluje z nich zbyt ciemne kolory.
  const FILL = { yellow: "FFF3A3", green: "C6F0C2" } as const;
  const highlights = (xml: string, color: "yellow" | "green") =>
    (xml.match(new RegExp(`<w:shd [^>]*w:fill="${FILL[color]}"/>`, "g")) ?? []).length;

  const onDiskPath = storedPathOf(d1.id);
  const beforeBytes = readFileSync(resolveStoredPath(onDiskPath)!);
  const rowBefore = db.select().from(schema.contractDrafts).where(eq(schema.contractDrafts.id, d1.id)).get()!;

  ok("GET /:id/file BEZ preview: zero pastelowych teł", highlights(documentXml(onDiskPath), "yellow") === 0 && highlights(documentXml(onDiskPath), "green") === 0, null);

  const prev = await asEditor.request(`${BASE}/${d1.id}/file?preview=1`);
  const prevXml = new PizZip(Buffer.from(await prev.arrayBuffer())).file("word/document.xml")!.asText();
  ok(
    "GET /:id/file?preview=1 → 200, inline, nagłówek X-Contract-Missing",
    prev.status === 200 &&
      /^inline;/.test(prev.headers.get("content-disposition") ?? "") &&
      /^\d+$/.test(prev.headers.get("x-contract-missing") ?? ""),
    { cd: prev.headers.get("content-disposition"), missing: prev.headers.get("x-contract-missing") }
  );
  ok("preview=1: wypełnione pola na zielono", highlights(prevXml, "green") > 0, highlights(prevXml, "green"));
  ok("preview=1: żadnych nawiasów klamrowych", !/[{}]/.test(prevXml), prevXml.match(/[{}][^<]{0,20}/g)?.slice(0, 5));

  const rowAfter = db.select().from(schema.contractDrafts).where(eq(schema.contractDrafts.id, d1.id)).get()!;
  ok(
    "preview=1: plik na dysku i kolumny generated_* nietknięte",
    readFileSync(resolveStoredPath(onDiskPath)!).equals(beforeBytes) &&
      rowAfter.generatedStoredPath === rowBefore.generatedStoredPath &&
      rowAfter.generatedAt === rowBefore.generatedAt &&
      rowAfter.generatedHash === rowBefore.generatedHash,
    { before: rowBefore.generatedStoredPath, after: rowAfter.generatedStoredPath }
  );

  // Draft bez osób kontaktowych — puste pola muszą wyjść na żółto.
  const prevGaps = await asEditor.request(`${BASE}/${otherCompany.json.data!.id}/file?preview=1`);
  const prevGapsXml = new PizZip(Buffer.from(await prevGaps.arrayBuffer())).file("word/document.xml")!.asText();
  ok(
    "preview=1: puste pola na żółto, wypełnione na zielono",
    highlights(prevGapsXml, "yellow") > 0 && highlights(prevGapsXml, "green") > 0,
    { yellow: highlights(prevGapsXml, "yellow"), green: highlights(prevGapsXml, "green") }
  );
  ok(
    "preview=1: X-Contract-Missing = liczba żółtych pól",
    Number(prevGaps.headers.get("x-contract-missing")) === highlights(prevGapsXml, "yellow"),
    { header: prevGaps.headers.get("x-contract-missing"), yellow: highlights(prevGapsXml, "yellow") }
  );

  // Wzór: WSZYSTKIE pola żółte, bo z definicji nic nie jest wypełnione.
  const blankPreview = await asEditor.request(`${BASE}/templates/${TEMPLATE}/file?preview=1`);
  const blankPreviewXml = new PizZip(Buffer.from(await blankPreview.arrayBuffer())).file("word/document.xml")!.asText();
  const fieldCount = tpl0?.fieldCount ?? 0;
  ok(
    "GET /templates/:key/file?preview=1: wszystkie pola żółte, zero zielonych",
    highlights(blankPreviewXml, "yellow") === fieldCount &&
      highlights(blankPreviewXml, "green") === 0 &&
      Number(blankPreview.headers.get("x-contract-missing")) === fieldCount,
    { yellow: highlights(blankPreviewXml, "yellow"), fieldCount, header: blankPreview.headers.get("x-contract-missing") }
  );
  ok("GET /templates/:key/file BEZ preview: zero pastelowych teł", highlights(blankXml, "yellow") === 0 && highlights(blankXml, "green") === 0, null);
  ok("GET /templates/:key/file?mode=tagged BEZ preview: zero pastelowych teł", highlights(taggedXml, "yellow") === 0, null);

  const taggedPreview = await asEditor.request(`${BASE}/templates/${TEMPLATE}/file?mode=tagged&preview=1`);
  const taggedPreviewXml = new PizZip(Buffer.from(await taggedPreview.arrayBuffer())).file("word/document.xml")!.asText();
  ok(
    "GET /templates/:key/file?mode=tagged&preview=1: tagi zostają, wszystkie żółte",
    taggedPreviewXml.includes("{numer}") && highlights(taggedPreviewXml, "yellow") === fieldCount,
    { yellow: highlights(taggedPreviewXml, "yellow"), fieldCount }
  );

  // ======================================================== 10. ZAŁĄCZNIKI
  const att = await upload<DraftJson>(asEditor, `/${d1.id}/attachments`, [
    { name: "skan.png", type: "image/png", data: png },
    { name: "notatka.txt", type: "text/plain", data: Buffer.from("podpisano 2026-01-07") },
  ]);
  const atts = att.json.data?.attachments ?? [];
  const img = atts.find((a) => a.kind === "image")!;
  const doc = atts.find((a) => a.kind === "file")!;
  ok("POST /:id/attachments → 200, obrazek przerobiony na WebP", att.status === 200 && img?.mimeType === "image/webp" && img.fileName === "skan.webp", img);
  ok("POST /:id/attachments: plik tekstowy bez zmian", doc?.mimeType === "text/plain" && doc.size === 20, doc);
  ok(
    "załącznik: url (inline) i downloadUrl pod trasą draftu",
    img.url === `/api/contracts/drafts/${d1.id}/attachments/${img.id}/download?inline=1` &&
      img.downloadUrl === `/api/contracts/drafts/${d1.id}/attachments/${img.id}/download`,
    { url: img.url }
  );
  const attStored = db.select().from(schema.contractDraftAttachments).where(eq(schema.contractDraftAttachments.id, img.id)).get()!.storedPath;
  ok("załącznik: plik obok wygenerowanego DOCX-a (ten sam katalog)", attStored.startsWith(`contract-drafts/${d1.id}/`) && existsSync(resolveStoredPath(attStored)!), attStored);

  const dl = await asEditor.request(`${BASE}/${d1.id}/attachments/${doc.id}/download`);
  ok("GET załącznika → 200 z treścią", dl.status === 200 && (await dl.text()) === "podpisano 2026-01-07");
  const dlForeign = await asEditor.request(`${BASE}/${otherCompany.json.data!.id}/attachments/${doc.id}/download`);
  ok("GET załącznika z id CUDZEGO draftu → 404", dlForeign.status === 404);
  const attMissingOwner = await upload<unknown>(asEditor, "/99999999/attachments", [{ name: "x.txt", type: "text/plain", data: Buffer.from("a") }]);
  ok(
    "POST załącznika do nieistniejącego draftu → 404 (bez katalogu na dysku)",
    attMissingOwner.status === 404 && !existsSync(join(ATTACHMENTS_DIR, "contract-drafts", "99999999")),
    attMissingOwner.json
  );
  const attNoFiles = await upload<unknown>(asEditor, `/${d1.id}/attachments`, []);
  ok("POST załączników bez plików → 400", attNoFiles.status === 400 && attNoFiles.json.error === "Nie wybrano plików", attNoFiles.json);

  const docStored = db.select().from(schema.contractDraftAttachments).where(eq(schema.contractDraftAttachments.id, doc.id)).get()!.storedPath;
  const delAtt = await send<{ id: number; draftId: number }>(asEditor, "DELETE", `/${d1.id}/attachments/${doc.id}`);
  ok(
    "DELETE załącznika → 200 { id, draftId } i plik znika z dysku",
    delAtt.status === 200 && delAtt.json.data?.draftId === d1.id && !existsSync(resolveStoredPath(docStored)!),
    delAtt.json
  );
  ok("DELETE załącznika: wiersz usunięty", !db.select().from(schema.contractDraftAttachments).where(eq(schema.contractDraftAttachments.id, doc.id)).get());
  ok("DELETE załącznika: wygenerowany DOCX nietknięty", existsSync(resolveStoredPath(storedPathOf(d1.id))!));

  // ======================================================== LISTY I FILTRY
  const list = await get<{ items: DraftJson[] }>(asEditor, `/?q=${encodeURIComponent(PREFIX)}`);
  ok("GET /?q= → drafty testowe na liście", list.status === 200 && (list.json.data?.items.length ?? 0) >= 4, list.json.data?.items.length);
  const byCompany = await get<{ items: DraftJson[] }>(asEditor, `/?companyId=${coB.id}`);
  ok("GET /?companyId= → tylko drafty tej spółki", byCompany.json.data?.items.every((i) => i.companyId === coB.id) === true, byCompany.json.data?.items.map((i) => i.companyName));
  const byStatus = await get<{ items: DraftJson[] }>(asEditor, `/?status=sent&q=${encodeURIComponent(PREFIX)}`);
  ok("GET /?status=sent → tylko wysłane", byStatus.json.data?.items.length === 1 && byStatus.json.data.items[0].id === d1.id, byStatus.json.data?.items.map((i) => i.status));
  const badStatus = await get<unknown>(asEditor, "/?status=cokolwiek");
  ok("GET /?status= nieznanego → 400 PL", badStatus.status === 400 && badStatus.json.error === "Nieprawidłowy status umowy", badStatus.json);
  const sorted = await get<{ items: DraftJson[] }>(asEditor, `/?companyId=${coA.id}&sort=number&dir=asc`);
  ok(
    "GET /?sort=number&dir=asc → po (rok, seq), nie po napisie",
    sorted.json.data?.items.map((i) => i.contractNumber).join() === "1/TST/2026,2/TST/2026,1/TST/2027",
    sorted.json.data?.items.map((i) => i.contractNumber)
  );
  const badSort = await get<unknown>(asEditor, "/?sort=cokolwiek");
  ok("GET /?sort= nieznanego → 400 PL", badSort.status === 400, badSort.json);
  const byObject = await get<{ items: DraftJson[] }>(asEditor, `/objects/${objB.id}`);
  ok("GET /objects/:objectId → drafty jednego obiektu", byObject.status === 200 && byObject.json.data?.items.every((i) => i.objectId === objB.id) === true, byObject.json.data?.items.length);
  const one = await get<DraftJson>(asEditor, `/${d1.id}`);
  ok("GET /:id → pełny JSON draftu", one.status === 200 && one.json.data?.id === d1.id && one.json.data.templateLabel === "Umowa ZDW — Alfa Group", one.json.data?.templateLabel);
  const oneMissing = await get<unknown>(asEditor, "/99999999");
  ok("GET /:id nieistniejącego → 404 PL", oneMissing.status === 404 && oneMissing.json.error === "Draft umowy nie istnieje", oneMissing.json);

  const pick = await get<{ items: { id: number; name: string; companyId: number | null; companyName: string | null }[] }>(
    asEditor,
    `/pick/objects?q=${encodeURIComponent(`${PREFIX} Obiekt A`)}`
  );
  ok(
    "GET /pick/objects?q= → obiekt ze spółką i kontrahentem",
    pick.status === 200 && pick.json.data?.items.length === 1 && pick.json.data.items[0].companyId === coA.id,
    pick.json.data?.items
  );
  ok(
    "GET /pick/objects: kształt bez kwot i statusów",
    Object.keys(pick.json.data!.items[0]).sort().join() === "address,city,companyId,companyName,contractorName,id,name",
    Object.keys(pick.json.data!.items[0]).sort()
  );

  // ============================================ 10a. PRZENIESIENIE DO REJESTRU
  // Draft to DOKUMENT, rejestr `contracts` to FAKT handlowy. „Przenieś do
  // rejestru” przepisuje jedno w drugie RAZ (numer, obiekt, data, abonament)
  // i zostawia w rejestrze wskaźnik na draft, żeby panel miał co pokazać
  // w podglądzie.
  const dDerived = derived.json.data!;
  const promoted = await send<PromoteJson>(asEditor, "POST", `/${dDerived.id}/promote`);
  const regRow = db.select().from(schema.contracts).where(eq(schema.contracts.draftId, dDerived.id)).get();
  ok(
    "POST /:id/promote → 200 i wiersz w rejestrze z draft_id",
    promoted.status === 200 && !!regRow && regRow.draftId === dDerived.id,
    promoted.json
  );
  ok(
    "promote: numer, obiekt, data i abonament przepisane 1:1",
    regRow?.contractNumber === dDerived.contractNumber &&
      regRow?.objectId === dDerived.objectId &&
      regRow?.startDate === dDerived.contractDate &&
      regRow?.value === 2500,
    regRow
  );
  ok(
    "promote: draft „Szkic” → umowa w rejestrze też jako szkic",
    dDerived.status === "draft" && regRow?.status === "draft",
    { draft: dDerived.status, rejestr: regRow?.status }
  );
  ok(
    "promote: status samego draftu bez zmian (rejestr ≠ podpis)",
    promoted.json.data?.draft.status === "draft" && promoted.json.data.draft.registryContractId === regRow?.id,
    promoted.json.data?.draft
  );
  ok(
    "promote: odpowiedź niesie adres pliku do podglądu",
    promoted.json.data?.contract.draftFileUrl === `/api/contracts/drafts/${dDerived.id}/file?inline=1`,
    promoted.json.data?.contract.draftFileUrl
  );
  ok(
    "promote: wpis w historii obiektu (contract_created)",
    db
      .select()
      .from(schema.objectHistory)
      .where(and(eq(schema.objectHistory.objectId, objA.id), eq(schema.objectHistory.action, "contract_created")))
      .all()
      .some((h) => (h.description ?? "").includes(`from draft ${dDerived.id}`)),
    null
  );

  const promotedAgain = await send<unknown>(asEditor, "POST", `/${dDerived.id}/promote`);
  ok(
    "promote drugi raz → 409 PL",
    promotedAgain.status === 409 && /jest już w rejestrze/.test(promotedAgain.json.error ?? ""),
    promotedAgain.json
  );

  // Numer jest w rejestrze unikalny — draft z zajętym numerem nie może wejść.
  const dTaken = (
    await send<DraftJson>(asEditor, "POST", "/", { objectId: objA.id, templateKey: TEMPLATE, contractDate: DATE, fields: {} })
  ).json.data!;
  db.insert(schema.contracts)
    .values({ objectId: objA.id, contractNumber: dTaken.contractNumber, startDate: DATE, status: "draft" })
    .run();
  const promoteTaken = await send<unknown>(asEditor, "POST", `/${dTaken.id}/promote`);
  ok(
    "promote z numerem zajętym w rejestrze → 409 PL",
    promoteTaken.status === 409 && /o numerze/.test(promoteTaken.json.error ?? ""),
    promoteTaken.json
  );
  ok(
    "promote 409: żaden wiersz nie powstał (transakcja się nie zapisała)",
    db.select().from(schema.contracts).where(eq(schema.contracts.draftId, dTaken.id)).all().length === 0,
    null
  );

  // Podpisany draft wchodzi do rejestru jako umowa OBOWIĄZUJĄCA.
  await send<DraftJson>(asEditor, "PUT", `/${d1.id}`, { status: "signed" });
  const promotedSigned = await send<PromoteJson>(asEditor, "POST", `/${d1.id}/promote`);
  ok(
    "promote draftu „Podpisana” → umowa w rejestrze jako „active”",
    promotedSigned.status === 200 && promotedSigned.json.data?.contract.status === "active",
    promotedSigned.json.data?.contract
  );

  // Rejestr umów musi teraz oddawać draftId i gotowy adres podglądu.
  const regList = await asEditor.request(`/contracts?search=${encodeURIComponent(dDerived.contractNumber)}`);
  const regJson = (await regList.json()) as { data: { id: number; draftId: number | null; draftFileUrl: string | null }[] };
  ok(
    "GET /contracts: umowa z draftu niesie draftId i draftFileUrl",
    regList.status === 200 &&
      regJson.data.length === 1 &&
      regJson.data[0].draftId === dDerived.id &&
      regJson.data[0].draftFileUrl === `/api/contracts/drafts/${dDerived.id}/file?inline=1`,
    regJson.data
  );
  const regOne = await asEditor.request(`/contracts/${regRow!.id}`);
  const regOneJson = (await regOne.json()) as { data: { draftId: number | null; draftFileUrl: string | null } };
  ok(
    "GET /contracts/:id: to samo w karcie pojedynczej umowy",
    regOne.status === 200 && regOneJson.data.draftId === dDerived.id && regOneJson.data.draftFileUrl !== null,
    regOneJson.data
  );
  // Umowa wpisana ręcznie (bez draftu) nie ma czego pokazać w podglądzie.
  const regManual = await asEditor.request(`/contracts?search=${encodeURIComponent(dTaken.contractNumber)}`);
  const regManualJson = (await regManual.json()) as { data: { draftId: number | null; draftFileUrl: string | null }[] };
  ok(
    "GET /contracts: umowa dodana ręcznie ma draftId i draftFileUrl = null",
    regManualJson.data[0]?.draftId === null && regManualJson.data[0]?.draftFileUrl === null,
    regManualJson.data[0]
  );

  const promoteViewer = await send<unknown>(asViewer, "POST", `/${dTaken.id}/promote`);
  ok("„view”: promote → 403", promoteViewer.status === 403, promoteViewer.json);
  const promoteMissing = await send<unknown>(asEditor, "POST", "/99999999/promote");
  ok("promote nieistniejącego draftu → 404", promoteMissing.status === 404, promoteMissing.json);

  // ======================================================== 11. UPRAWNIENIA
  const gStranger = await get<unknown>(asStranger, "/");
  ok("bez klucza `contracts`: GET → 403", gStranger.status === 403 && gStranger.json.error === "Brak dostępu do tej sekcji", gStranger.json);
  const gViewer = await get<{ items: DraftJson[] }>(asViewer, "/");
  ok("„view”: GET → 200", gViewer.status === 200 && Array.isArray(gViewer.json.data?.items), gViewer.json);
  const pViewer = await send<unknown>(asViewer, "POST", "/", { objectId: objA.id, templateKey: TEMPLATE, fields: {} });
  ok("„view”: POST → 403 („tryb tylko do odczytu”)", pViewer.status === 403 && /tylko do odczytu/.test(pViewer.json.error ?? ""), pViewer.json);
  const uViewer = await send<unknown>(asViewer, "PUT", `/${d1.id}`, { status: "signed" });
  ok("„view”: PUT → 403", uViewer.status === 403, uViewer.json);
  const genViewer = await send<unknown>(asViewer, "POST", `/${d1.id}/generate`);
  ok("„view”: generowanie → 403", genViewer.status === 403, genViewer.json);
  const dViewer = await send<unknown>(asViewer, "DELETE", `/${d1.id}`);
  ok("„view”: DELETE → 403", dViewer.status === 403, dViewer.json);
  const fileViewer = await asViewer.request(`${BASE}/${d1.id}/file`);
  ok("„view”: pobranie dokumentu → 200 (podgląd wolno)", fileViewer.status === 200);
  const gAdmin = await get<{ items: DraftJson[] }>(asAdmin, "/");
  ok("admin: GET → 200", gAdmin.status === 200);

  // ======================================================== 12. KASOWANIE
  const dDel = (
    await send<DraftJson>(asEditor, "POST", "/", { objectId: objDel.id, templateKey: TEMPLATE, contractDate: DATE, fields: {} })
  ).json.data!;
  await upload<DraftJson>(asEditor, `/${dDel.id}/attachments`, [{ name: "aneks.txt", type: "text/plain", data: Buffer.from("aneks") }]);
  const dirDel = join(ATTACHMENTS_DIR, "contract-drafts", String(dDel.id));
  ok("przed kasowaniem obiektu: katalog draftu istnieje", existsSync(dirDel));

  // Kasowanie obiektu to zakładka „objects” — wołamy jako admin.
  const delObject = await asAdmin.request(`/objects/${objDel.id}`, { method: "DELETE" });
  ok("DELETE /objects/:id z draftem → 200 (draft nie blokuje)", delObject.status === 200, await delObject.json());
  ok(
    "DELETE obiektu: draft znika kaskadą, katalog skasowany",
    db.select().from(schema.contractDrafts).where(eq(schema.contractDrafts.objectId, objDel.id)).all().length === 0 && !existsSync(dirDel),
    { dir: existsSync(dirDel) }
  );

  const dirD1 = join(ATTACHMENTS_DIR, "contract-drafts", String(d1.id));
  ok("przed DELETE draftu: katalog istnieje", existsSync(dirD1));
  const registryOfD1 = promotedSigned.json.data!.contract.id;
  const delDraft = await send<{ id: number }>(asEditor, "DELETE", `/${d1.id}`);
  ok("DELETE /:id → 200 i katalog skasowany (rm -r)", delDraft.status === 200 && !existsSync(dirD1), delDraft.json);
  // Umowa w rejestrze to FAKT — kasowanie dokumentu nie może jej zabrać.
  // ON DELETE SET NULL zostawia wiersz i tylko odpina plik.
  const afterDelete = db.select().from(schema.contracts).where(eq(schema.contracts.id, registryOfD1)).get();
  ok(
    "DELETE draftu: umowa w rejestrze zostaje, draft_id wyzerowany (SET NULL)",
    !!afterDelete && afterDelete.draftId === null,
    afterDelete
  );
  const delAgain = await send<unknown>(asEditor, "DELETE", `/${d1.id}`);
  ok("DELETE /:id już usuniętego → 404", delAgain.status === 404);

  const logs = db.select().from(schema.activityLog).where(eq(schema.activityLog.entityType, "contract_draft")).all();
  ok(
    "activity_log: wpisy created/updated/deleted pod encją contract_draft",
    ["created", "updated", "deleted"].every((a) => logs.some((l) => l.action === a)),
    logs.map((l) => [l.action, l.objectId])
  );
  // objectId wiąże wpis z historią obiektu. Po skasowaniu obiektu kolumna jest
  // zerowana kaskadą (activity_log.object_id ON DELETE SET NULL) — dlatego
  // sprawdzamy wpisy obiektu, który przeżył.
  ok(
    "activity_log: wpisy niosą objectId do historii obiektu",
    logs.some((l) => l.action === "created" && l.objectId === objA.id) &&
      logs.some((l) => l.action === "updated" && l.field === "generated" && l.objectId === objA.id) &&
      logs.some((l) => l.action === "deleted" && l.objectId === objA.id),
    logs.map((l) => [l.action, l.field, l.objectId])
  );
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} draftów testowych)`);
}

console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
