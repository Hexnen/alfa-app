/**
 * Test modułu Grupy interwencyjne (/api/cma/intervention-groups) — przez trasy Hono
 * (app.request) z podstawionym userem i strażnikiem uprawnień, na KOPII bazy:
 *   npx tsx scripts/test-on-copy.ts scripts/test-intervention-groups.ts
 *
 * Sprawdza: firmy (duplikat bez względu na wielkość liter, skrót {active}, blokada
 * kasowania), warunki (walidacja dat i kwot, NAKŁADANIE OKRESÓW, isCurrent, filtry),
 * interwencje (rozwiązanie warunków z dnia zdarzenia, numeracja i darmowe podjazdy
 * w miesiącu, koszt postoju, summary, przeliczenie wstecz po zmianie warunków),
 * picker obiektów, szablony maili (domyślne / zapisane / przywrócone), podgląd
 * i wysyłkę (w tym escapowanie HTML z kartoteki), załączniki dla wszystkich trzech
 * właścicieli oraz strażnika uprawnień.
 *
 * Sprząta po sobie HARD (wiersze + katalogi załączników + activity_log + mail_log
 * + klucze app_settings + fikstury obiektu i kontrahenta), także przy błędzie.
 */
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import interventionGroupsRoutes from "../src/routes/intervention-groups.js";
import objectsRoutes from "../src/routes/objects.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import { ATTACHMENTS_DIR, removeAttachmentDir, resolveStoredPath } from "../src/lib/calendar-attachments.js";
import { INTERVENTION_MAIL_SETTING_KEYS } from "../src/lib/intervention-mail.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const PREFIX = "__IGRP_TEST__";
const BASE = "/cma/intervention-groups";

const admin = db.select().from(schema.users).where(eq(schema.users.role, "admin")).limit(1).get() as User;
const plain = db.select().from(schema.users).where(eq(schema.users.role, "user")).limit(1).get() as User;
if (!admin || !plain) throw new Error("Test wymaga admina i zwykłego użytkownika w bazie");

function withPerms(user: User, permissions: Record<string, "view" | "edit"> | null): User {
  return { ...user, role: "user", permissions: permissions ? JSON.stringify(permissions) : null };
}

function cleanup(): number {
  const companyIds = db
    .select({ id: schema.interventionCompanies.id })
    .from(schema.interventionCompanies)
    .where(like(schema.interventionCompanies.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const objectIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);

  const termRows = db.select().from(schema.interventionTerms).all();
  const mineTerms = termRows
    .filter((t) => companyIds.includes(t.companyId) || objectIds.includes(t.objectId))
    .map((t) => t.id);
  const interventionRows = db.select().from(schema.interventions).all();
  const mineInterventions = interventionRows
    .filter((i) => mineTerms.includes(i.termId) || objectIds.includes(i.objectId))
    .map((i) => i.id);

  for (const id of mineInterventions) removeAttachmentDir(`interventions/interventions/${id}`);
  for (const id of mineTerms) removeAttachmentDir(`interventions/terms/${id}`);
  for (const id of companyIds) removeAttachmentDir(`interventions/companies/${id}`);

  if (mineInterventions.length) {
    db.delete(schema.interventions).where(inArray(schema.interventions.id, mineInterventions)).run();
    db.delete(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "intervention"),
          inArray(schema.activityLog.entityId, mineInterventions)
        )
      )
      .run();
  }
  if (mineTerms.length) {
    db.delete(schema.interventionTerms).where(inArray(schema.interventionTerms.id, mineTerms)).run();
    db.delete(schema.activityLog)
      .where(
        and(eq(schema.activityLog.entityType, "intervention_term"), inArray(schema.activityLog.entityId, mineTerms))
      )
      .run();
  }
  if (companyIds.length) {
    db.delete(schema.interventionCompanies)
      .where(inArray(schema.interventionCompanies.id, companyIds))
      .run();
    db.delete(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "intervention_company"),
          inArray(schema.activityLog.entityId, companyIds)
        )
      )
      .run();
    db.delete(schema.mailLog)
      .where(and(eq(schema.mailLog.entityType, "intervention_group"), inArray(schema.mailLog.entityId, companyIds)))
      .run();
  }
  if (objectIds.length) {
    db.delete(schema.objects).where(inArray(schema.objects.id, objectIds)).run();
  }
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  db.delete(schema.appSettings).where(inArray(schema.appSettings.key, INTERVENTION_MAIL_SETTING_KEYS)).run();
  db.delete(schema.activityLog).where(eq(schema.activityLog.entityType, "intervention_template")).run();
  return companyIds.length;
}
cleanup();

/** Aplikacja testowa: strażnik zakładek + router (jak w src/routes/index.ts). */
function appFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route(BASE, interventionGroupsRoutes);
  app.route("/objects", objectsRoutes);
  return app;
}
const asAdmin = appFor(admin);
const asEditor = appFor(withPerms(plain, { "cma/grupy-interwencyjne": "edit" }));
const asViewer = appFor(withPerms(plain, { "cma/grupy-interwencyjne": "view" }));
const asStranger = appFor(withPerms(plain, { "cma/raporty": "edit" }));

type Resp<T> = { success: boolean; data?: T; error?: string };
type AttJson = {
  id: number;
  fileName: string;
  mimeType: string;
  size: number;
  kind: string;
  width: number | null;
  height: number | null;
  url: string;
  downloadUrl: string;
  createdAt: string;
};
type CompanyJson = {
  id: number;
  name: string;
  area: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  objectsCount: number;
  activeTermsCount: number;
  attachments: AttJson[];
};
type TermJson = {
  id: number;
  objectId: number;
  companyId: number;
  companyName: string;
  objectName: string;
  objectCity: string | null;
  contractorName: string | null;
  startDate: string;
  endDate: string | null;
  calloutFee: number | null;
  subscriptionFee: number | null;
  freeCallouts: number | null;
  hourlyStandbyFee: number | null;
  isCurrent: boolean;
  attachments: AttJson[];
};
type InterventionJson = {
  id: number;
  objectId: number;
  objectName: string;
  companyId: number;
  companyName: string;
  termId: number;
  happenedAt: string;
  standbyHours: number | null;
  seqInMonth: number;
  isFree: boolean;
  calloutCost: number | null;
  standbyCost: number | null;
  totalCost: number | null;
  attachments: AttJson[];
};
type Summary = { count: number; freeCount: number; calloutCost: number; standbyCost: number; totalCost: number };
type TemplateJson = {
  kind: string;
  label: string;
  subject: string;
  body: string;
  subjectDefault: string;
  bodyDefault: string;
  isDefault: boolean;
  updatedAt: string | null;
};

async function get<T>(app: Hono, path: string): Promise<{ status: number; json: Resp<T> }> {
  const res = await app.request(BASE + path);
  return { status: res.status, json: (await res.json()) as Resp<T> };
}
async function send<T>(
  app: Hono,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ status: number; json: Resp<T> }> {
  const res = await app.request(BASE + path, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return { status: res.status, json: (await res.json()) as Resp<T> };
}
function multipart(files: { name: string; type: string; data: Buffer }[]): FormData {
  const fd = new FormData();
  for (const f of files) fd.append("files", new File([new Uint8Array(f.data)], f.name, { type: f.type }));
  return fd;
}
async function upload<T>(
  app: Hono,
  path: string,
  files: { name: string; type: string; data: Buffer }[]
): Promise<{ status: number; json: Resp<T> }> {
  const res = await app.request(BASE + path, { method: "POST", body: multipart(files) });
  return { status: res.status, json: (await res.json()) as Resp<T> };
}

const png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: { r: 20, g: 120, b: 60 } } })
  .png()
  .toBuffer();
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

// --- fikstury: kontrahent + trzy obiekty ---
const contractor = db
  .insert(schema.contractors)
  .values({ name: `${PREFIX} Kontrahent`, nip: "0000000000" })
  .returning()
  .get();
const objectValues = (name: string, city: string) => ({
  contractorId: contractor.id,
  name,
  address: `ul. Testowa 1`,
  city,
  type: "monitoring" as const,
  installationType: "new" as const,
});
const objA = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt A`, "Warszawa")).returning().get();
const objB = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt B`, "Kraków")).returning().get();
const objC = db.insert(schema.objects).values(objectValues(`${PREFIX} Obiekt C`, "Gdańsk")).returning().get();

try {
  // ======================================================== 1. FIRMY
  const c1r = await send<CompanyJson>(asEditor, "POST", "/companies", {
    name: `${PREFIX} Alfa Interwencje`,
    area: "Warszawa i okolice",
    contactPerson: "Jan Nowak",
    phone: "600 100 200",
    email: "kontakt@alfa-interwencje.invalid",
    notes: "umowa ramowa 2026",
  });
  const c1 = c1r.json.data!;
  ok(
    "POST /companies → 201 z pełnym JSON-em",
    c1r.status === 201 && c1?.name === `${PREFIX} Alfa Interwencje` && c1.active === true && c1.objectsCount === 0,
    c1r.json
  );
  const c2r = await send<CompanyJson>(asEditor, "POST", "/companies", { name: `${PREFIX} Beta Ochrona` });
  const c2 = c2r.json.data!;
  ok("POST /companies bez pól opcjonalnych → 201, null-e zamiast pustych napisów", c2r.status === 201 && c2.area === null && c2.email === null, c2r.json);

  const dup = await send<CompanyJson>(asEditor, "POST", "/companies", { name: `${PREFIX} alfa INTERWENCJE` });
  ok("POST /companies duplikat inną wielkością liter → 409", dup.status === 409 && /już istnieje/.test(dup.json.error ?? ""), dup.json);
  const noName = await send<CompanyJson>(asEditor, "POST", "/companies", { name: "  " });
  ok("POST /companies bez nazwy → 400", noName.status === 400 && noName.json.error === "Nazwa firmy jest wymagana", noName.json);
  const badMail = await send<CompanyJson>(asEditor, "POST", "/companies", { name: `${PREFIX} Zła poczta`, email: "jan@" });
  ok("POST /companies ze złym e-mailem → 400", badMail.status === 400 && /adres e-mail/.test(badMail.json.error ?? ""), badMail.json);

  const upd = await send<CompanyJson>(asEditor, "PUT", `/companies/${c1.id}`, {
    name: `${PREFIX} Alfa Interwencje`,
    area: "mazowieckie",
    contactPerson: "Jan Nowak",
    phone: "600 100 200",
    email: "kontakt@alfa-interwencje.invalid",
    notes: "",
  });
  ok("PUT /companies/:id → zmienione pola, pusta notatka → null", upd.status === 200 && upd.json.data?.area === "mazowieckie" && upd.json.data.notes === null, upd.json);
  const arch = await send<CompanyJson>(asEditor, "PUT", `/companies/${c2.id}`, { active: false });
  ok("PUT /companies/:id skrót { active:false } → zarchiwizowana", arch.status === 200 && arch.json.data?.active === false && arch.json.data.name === `${PREFIX} Beta Ochrona`, arch.json);

  const listAll = await get<{ items: CompanyJson[] }>(asEditor, `/companies?q=${encodeURIComponent(PREFIX)}`);
  ok("GET /companies?q= → obie firmy, aktywne pierwsze", listAll.status === 200 && listAll.json.data?.items.length === 2 && listAll.json.data.items[0].id === c1.id, listAll.json.data?.items.map((i) => i.name));
  const listActive = await get<{ items: CompanyJson[] }>(asEditor, `/companies?status=active&q=${encodeURIComponent(PREFIX)}`);
  ok("GET /companies?status=active → tylko aktywna", listActive.json.data?.items.length === 1 && listActive.json.data.items[0].id === c1.id, listActive.json.data?.items.map((i) => i.name));
  const listArch = await get<{ items: CompanyJson[] }>(asEditor, `/companies?status=archived&q=${encodeURIComponent(PREFIX)}`);
  ok("GET /companies?status=archived → tylko zarchiwizowana", listArch.json.data?.items.length === 1 && listArch.json.data.items[0].id === c2.id, listArch.json.data?.items.map((i) => i.name));

  // Firma odarchiwizowana — będzie potrzebna przy warunkach.
  await send<CompanyJson>(asEditor, "PUT", `/companies/${c2.id}`, { active: true });

  // ======================================================== 2. WARUNKI
  const t1r = await send<TermJson>(asEditor, "POST", "/terms", {
    objectId: objA.id,
    companyId: c1.id,
    startDate: "2026-01-01",
    calloutFee: "200",
    subscriptionFee: "500,50",
    freeCallouts: 2,
    hourlyStandbyFee: 60,
    notes: "umowa na obiekt",
  });
  const t1 = t1r.json.data!;
  ok(
    "POST /terms → 201, kwoty z przecinkiem, isCurrent dla pustej daty końca",
    t1r.status === 201 && t1?.calloutFee === 200 && t1.subscriptionFee === 500.5 && t1.isCurrent === true && t1.endDate === null,
    t1r.json
  );
  ok("POST /terms: nazwy obiektu, kontrahenta i firmy w JSON-ie", t1.objectName === objA.name && t1.contractorName === contractor.name && t1.companyName === c1.name, t1);

  const badEnd = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: c1.id, startDate: "2026-03-01", endDate: "2026-02-01" });
  ok("POST /terms z endDate < startDate → 400", badEnd.status === 400 && /wcześniejsza/.test(badEnd.json.error ?? ""), badEnd.json);
  const badFee = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: c1.id, startDate: "2026-03-01", calloutFee: "abc" });
  ok("POST /terms z kwotą „abc” → 400", badFee.status === 400 && /musi być liczbą/.test(badFee.json.error ?? ""), badFee.json);
  const negFee = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: c1.id, startDate: "2026-03-01", calloutFee: -5 });
  ok("POST /terms z ujemną kwotą → 400", negFee.status === 400 && /ujemna/.test(negFee.json.error ?? ""), negFee.json);
  const badFree = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: c1.id, startDate: "2026-03-01", freeCallouts: 1.5 });
  ok("POST /terms z ułamkową liczbą darmowych podjazdów → 400", badFree.status === 400, badFree.json);
  const noObject = await send<TermJson>(asEditor, "POST", "/terms", { objectId: 99999999, companyId: c1.id, startDate: "2026-03-01" });
  ok("POST /terms z nieistniejącym obiektem → 400", noObject.status === 400 && noObject.json.error === "Nie ma takiego obiektu", noObject.json);
  const noCompany = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: 99999999, startDate: "2026-03-01" });
  ok("POST /terms z nieistniejącą firmą → 400", noCompany.status === 400 && noCompany.json.error === "Nie ma takiej firmy", noCompany.json);
  const badDate = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: c1.id, startDate: "01.03.2026" });
  ok("POST /terms ze złym formatem daty → 400", badDate.status === 400 && /RRRR-MM-DD/.test(badDate.json.error ?? ""), badDate.json);

  const overlap = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objA.id, companyId: c2.id, startDate: "2026-06-01" });
  ok(
    "POST /terms nakładające się na istniejący okres → 409 z nazwą firmy i datą",
    overlap.status === 409 && overlap.json.error?.includes(c1.name) === true && overlap.json.error?.includes("2026-01-01") === true,
    overlap.json
  );

  // Sekwencyjne okresy na drugim obiekcie: zamknięty (przeszły) + otwarty z datą w przyszłości.
  const tB1r = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: c2.id, startDate: "2020-01-01", endDate: "2020-12-31", calloutFee: 150 });
  const tB1 = tB1r.json.data!;
  ok("POST /terms okres zamknięty w przeszłości → 201, isCurrent=false", tB1r.status === 201 && tB1.isCurrent === false, tB1r.json);
  const tB2r = await send<TermJson>(asEditor, "POST", "/terms", { objectId: objB.id, companyId: c1.id, startDate: "2021-01-01", endDate: "2099-12-31" });
  const tB2 = tB2r.json.data!;
  ok("POST /terms okres sekwencyjny (bez nakładania) → 201, isCurrent=true dla daty w przyszłości", tB2r.status === 201 && tB2.isCurrent === true, tB2r.json);

  const byCompany = await get<{ items: TermJson[] }>(asEditor, `/terms?companyId=${c2.id}`);
  ok("GET /terms?companyId= → tylko warunki tej firmy", byCompany.json.data?.items.every((t) => t.companyId === c2.id) === true && byCompany.json.data.items.some((t) => t.id === tB1.id), byCompany.json.data?.items.map((t) => t.id));
  const ended = await get<{ items: TermJson[] }>(asEditor, `/terms?status=ended&q=${encodeURIComponent(`${PREFIX} Obiekt B`)}`);
  ok("GET /terms?status=ended → tylko zakończone", ended.json.data?.items.length === 1 && ended.json.data.items[0].id === tB1.id, ended.json.data?.items.map((t) => t.id));
  const current = await get<{ items: TermJson[] }>(asEditor, `/terms?status=current&q=${encodeURIComponent(`${PREFIX} Obiekt B`)}`);
  ok("GET /terms?status=current → tylko obowiązujące", current.json.data?.items.length === 1 && current.json.data.items[0].id === tB2.id, current.json.data?.items.map((t) => t.id));
  const byQ = await get<{ items: TermJson[] }>(asEditor, `/terms?q=${encodeURIComponent("Kraków")}`);
  ok("GET /terms?q= szuka po mieście obiektu", byQ.json.data?.items.every((t) => t.objectId === objB.id) === true && (byQ.json.data?.items.length ?? 0) === 2, byQ.json.data?.items.map((t) => t.objectName));

  const objTerms = await get<{ items: TermJson[] }>(asEditor, `/objects/${objB.id}/terms`);
  ok(
    "GET /objects/:id/terms → malejąco po dacie startu",
    objTerms.status === 200 && objTerms.json.data?.items.map((t) => t.id).join() === `${tB2.id},${tB1.id}`,
    objTerms.json.data?.items.map((t) => t.startDate)
  );

  // ======================================================== 3. INTERWENCJE
  const noTerms = await send<InterventionJson>(asEditor, "POST", "/interventions", { objectId: objA.id, happenedAt: "2025-12-31T10:00" });
  ok(
    "POST /interventions w dniu bez warunków → 400",
    noTerms.status === 400 && noTerms.json.error === "Obiekt nie ma warunków grupy interwencyjnej obowiązujących w tym dniu",
    noTerms.json
  );
  const badTime = await send<InterventionJson>(asEditor, "POST", "/interventions", { objectId: objA.id, happenedAt: "2026-05-04 10:00" });
  ok("POST /interventions ze złym formatem daty i godziny → 400", badTime.status === 400 && badTime.json.error === "Nieprawidłowa data i godzina", badTime.json);

  const i1 = (await send<InterventionJson>(asEditor, "POST", "/interventions", { objectId: objA.id, happenedAt: "2026-05-04T10:00", reason: "Alarm SSWiN", reportedBy: "Operator CMA" })).json.data!;
  const i2 = (await send<InterventionJson>(asEditor, "POST", "/interventions", { objectId: objA.id, happenedAt: "2026-05-10T12:00", reason: "Otwarte drzwi" })).json.data!;
  const i3r = await send<InterventionJson>(asEditor, "POST", "/interventions", { objectId: objA.id, happenedAt: "2026-05-20T08:30", reason: "Sabotaż czujki", standbyHours: "1,5" });
  const i3 = i3r.json.data!;
  ok("POST /interventions → 201 z rozwiązanymi warunkami i firmą", i3r.status === 201 && i3.termId === t1.id && i3.companyId === c1.id, i3r.json);

  const month = await get<{ items: InterventionJson[]; summary: Summary }>(asEditor, `/interventions?month=2026-05&objectId=${objA.id}`);
  const items = month.json.data?.items ?? [];
  const byId = (id: number) => items.find((i) => i.id === id)!;
  ok("GET /interventions?month= → 3 wiersze miesiąca", month.status === 200 && items.length === 3, items.map((i) => i.happenedAt));
  ok(
    "rozliczenie: numeracja 1,2,3 wg daty",
    byId(i1.id)?.seqInMonth === 1 && byId(i2.id)?.seqInMonth === 2 && byId(i3.id)?.seqInMonth === 3,
    items.map((i) => [i.happenedAt, i.seqInMonth])
  );
  ok(
    "rozliczenie: przy free_callouts=2 pierwsze dwa darmowe, trzeci płatny",
    byId(i1.id)?.isFree === true && byId(i2.id)?.isFree === true && byId(i3.id)?.isFree === false,
    items.map((i) => [i.seqInMonth, i.isFree])
  );
  ok(
    "rozliczenie: calloutCost 0, 0, 200",
    byId(i1.id)?.calloutCost === 0 && byId(i2.id)?.calloutCost === 0 && byId(i3.id)?.calloutCost === 200,
    items.map((i) => i.calloutCost)
  );
  ok(
    "rozliczenie: postój 1,5 h × 60 zł = 90, razem 290",
    byId(i3.id)?.standbyHours === 1.5 && byId(i3.id)?.standbyCost === 90 && byId(i3.id)?.totalCost === 290,
    byId(i3.id)
  );
  ok("rozliczenie: brak postoju → standbyCost null, total = koszt podjazdu", byId(i1.id)?.standbyCost === null && byId(i1.id)?.totalCost === 0, byId(i1.id));
  const sum = month.json.data?.summary;
  ok(
    "summary: count 3, freeCount 2, kwoty zsumowane",
    sum?.count === 3 && sum.freeCount === 2 && sum.calloutCost === 200 && sum.standbyCost === 90 && sum.totalCost === 290,
    sum
  );

  const otherMonth = await get<{ items: InterventionJson[]; summary: Summary }>(asEditor, `/interventions?month=2026-04&objectId=${objA.id}`);
  ok("GET /interventions?month= innego miesiąca → pusto", otherMonth.json.data?.items.length === 0 && otherMonth.json.data.summary.count === 0, otherMonth.json.data?.summary);

  const byCompanyFilter = await get<{ items: InterventionJson[] }>(asEditor, `/interventions?month=2026-05&companyId=${c2.id}`);
  ok("GET /interventions?companyId= innej firmy → pusto (filtr po rozliczeniu)", byCompanyFilter.json.data?.items.length === 0, byCompanyFilter.json.data?.items);
  const byQuery = await get<{ items: InterventionJson[] }>(asEditor, `/interventions?month=2026-05&q=${encodeURIComponent("sabotaż")}`);
  ok(
    "GET /interventions?q= filtruje PO wyliczeniu — numer w miesiącu zostaje 3",
    byQuery.json.data?.items.length === 1 && byQuery.json.data.items[0].seqInMonth === 3 && byQuery.json.data.items[0].isFree === false,
    byQuery.json.data?.items
  );

  // Korekta warunków przelicza historię wstecz.
  await send<TermJson>(asEditor, "PUT", `/terms/${t1.id}`, {
    companyId: c1.id,
    startDate: "2026-01-01",
    calloutFee: 200,
    freeCallouts: 1,
    hourlyStandbyFee: 60,
  });
  const after = await get<{ items: InterventionJson[]; summary: Summary }>(asEditor, `/interventions?month=2026-05&objectId=${objA.id}`);
  const afterById = (id: number) => after.json.data!.items.find((i) => i.id === id)!;
  ok(
    "zmiana free_callouts na 1 → drugi podjazd staje się płatny (przeliczenie przy odczycie)",
    afterById(i2.id).isFree === false && afterById(i2.id).calloutCost === 200 && after.json.data?.summary.freeCount === 1,
    after.json.data?.items.map((i) => [i.seqInMonth, i.isFree, i.calloutCost])
  );

  const moveOutside = await send<TermJson>(asEditor, "PUT", `/terms/${t1.id}`, { companyId: c1.id, startDate: "2026-06-01" });
  ok(
    "PUT /terms/:id z datą odcinającą zarejestrowane interwencje → 409",
    moveOutside.status === 409 && /nie obejmuje zarejestrowanych interwencji \(3\)/.test(moveOutside.json.error ?? ""),
    moveOutside.json
  );
  const delTermUsed = await send<{ id: number }>(asEditor, "DELETE", `/terms/${t1.id}`);
  ok("DELETE /terms/:id z interwencjami → 409", delTermUsed.status === 409 && delTermUsed.json.error === "Warunki mają zarejestrowane interwencje (3)", delTermUsed.json);
  const delCompanyUsed = await send<{ id: number }>(asEditor, "DELETE", `/companies/${c1.id}`);
  ok(
    "DELETE /companies/:id z warunkami → 409 z podpowiedzią o archiwum",
    delCompanyUsed.status === 409 && /zarchiwizuj zamiast usuwać/.test(delCompanyUsed.json.error ?? ""),
    delCompanyUsed.json
  );

  const moveNoTerms = await send<InterventionJson>(asEditor, "PUT", `/interventions/${i1.id}`, { happenedAt: "2025-01-01T10:00" });
  ok("PUT /interventions/:id na dzień bez warunków → 400", moveNoTerms.status === 400 && /nie ma warunków/.test(moveNoTerms.json.error ?? ""), moveNoTerms.json);
  const movedOk = await send<InterventionJson>(asEditor, "PUT", `/interventions/${i1.id}`, { happenedAt: "2026-05-25T22:15", reason: "Alarm SSWiN", standbyHours: "" });
  ok(
    "PUT /interventions/:id z datą po pozostałych → numer w miesiącu 3",
    movedOk.status === 200 && movedOk.json.data?.seqInMonth === 3 && movedOk.json.data.standbyHours === null,
    movedOk.json
  );
  await send<InterventionJson>(asEditor, "PUT", `/interventions/${i1.id}`, { happenedAt: "2026-05-04T10:00", reason: "Alarm SSWiN" });

  const objInterventions = await get<{ items: InterventionJson[]; summary: Summary }>(asEditor, `/objects/${objA.id}/interventions`);
  ok("GET /objects/:id/interventions bez month → cała historia obiektu", objInterventions.status === 200 && objInterventions.json.data?.items.length === 3, objInterventions.json.data?.items.length);

  // ======================================================== 4. PICKER
  const pick = await get<{ items: { id: number; name: string; address: string | null; city: string | null; contractorName: string | null }[] }>(
    asEditor,
    `/pick/objects?q=${encodeURIComponent(`${PREFIX} Obiekt A`)}`
  );
  ok(
    "GET /pick/objects?q= → dopasowany obiekt z kontrahentem",
    pick.status === 200 && pick.json.data?.items.length === 1 && pick.json.data.items[0].id === objA.id && pick.json.data.items[0].contractorName === contractor.name,
    pick.json.data?.items
  );
  ok(
    "GET /pick/objects: kształt { id, name, address, city, contractorName }",
    Object.keys(pick.json.data!.items[0]).sort().join() === "address,city,contractorName,id,name",
    pick.json.data?.items[0]
  );
  const pickAll = await get<{ items: unknown[] }>(asEditor, "/pick/objects");
  ok("GET /pick/objects bez q → maks. 30 pozycji", (pickAll.json.data?.items.length ?? 0) <= 30, pickAll.json.data?.items.length);

  // ======================================================== 5. SZABLONY
  const tpl0 = await get<{ items: TemplateJson[]; placeholders: { token: string }[] }>(asEditor, "/mail/templates");
  ok(
    "GET /mail/templates → dwa szablony domyślne + placeholdery",
    tpl0.status === 200 && tpl0.json.data?.items.length === 2 && tpl0.json.data.items.every((t) => t.isDefault) && (tpl0.json.data.placeholders.length ?? 0) >= 8,
    tpl0.json.data?.items.map((t) => [t.kind, t.isDefault])
  );
  const tplPut = await send<TemplateJson>(asEditor, "PUT", "/mail/templates/rfq", { subject: "Zapytanie {{obiekt}}", body: "Dzień dobry {{osoba}},\n\nprosimy o ofertę.\n\n{{nadawca}}" });
  ok("PUT /mail/templates/rfq → zapisany, isDefault=false", tplPut.status === 200 && tplPut.json.data?.isDefault === false && tplPut.json.data.subject === "Zapytanie {{obiekt}}", tplPut.json);
  const tplEmpty = await send<TemplateJson>(asEditor, "PUT", "/mail/templates/rfq", { subject: "", body: "cokolwiek" });
  ok("PUT /mail/templates z pustym tematem → 400", tplEmpty.status === 400 && /Temat/.test(tplEmpty.json.error ?? ""), tplEmpty.json);
  const tplBadKind = await send<TemplateJson>(asEditor, "PUT", "/mail/templates/cokolwiek", { subject: "x", body: "y" });
  ok("PUT /mail/templates/:kind z nieznanym rodzajem → 400", tplBadKind.status === 400, tplBadKind.json);
  const tplDel = await send<TemplateJson>(asEditor, "DELETE", "/mail/templates/rfq");
  ok(
    "DELETE /mail/templates/rfq → przywrócony domyślny",
    tplDel.status === 200 && tplDel.json.data?.isDefault === true && tplDel.json.data.subject === tplDel.json.data.subjectDefault,
    tplDel.json
  );

  // ======================================================== 6. PODGLĄD I WYSYŁKA
  const prevNoObject = await send<{ subject: string; html: string; text: string; to: string; missing: string[]; sending: { ready: boolean } }>(
    asEditor,
    "POST",
    "/mail/preview",
    { kind: "rfq", companyId: c1.id }
  );
  ok(
    "POST /mail/preview rfq bez obiektu → tokeny obiektu w missing",
    prevNoObject.status === 200 && ["{{obiekt}}", "{{adres_obiektu}}", "{{miasto}}"].every((t) => prevNoObject.json.data!.missing.includes(t)),
    prevNoObject.json.data?.missing
  );
  ok("POST /mail/preview: adresat z kartoteki firmy", prevNoObject.json.data?.to === "kontakt@alfa-interwencje.invalid", prevNoObject.json.data?.to);
  const prevObject = await send<{ subject: string; html: string; text: string; missing: string[] }>(asEditor, "POST", "/mail/preview", {
    kind: "rfq",
    companyId: c1.id,
    objectId: objA.id,
  });
  ok(
    "POST /mail/preview rfq z obiektem → nazwa obiektu w temacie i treści, brak tokenów obiektu w missing",
    prevObject.json.data?.subject.includes(objA.name) === true &&
      prevObject.json.data.text.includes("Warszawa") &&
      !prevObject.json.data.missing.includes("{{obiekt}}"),
    { subject: prevObject.json.data?.subject, missing: prevObject.json.data?.missing }
  );
  ok(
    "POST /mail/preview: żadnego „undefined”/„null” w treści ani surowego tokenu",
    !/undefined|null|\{\{/.test(prevObject.json.data!.text),
    prevObject.json.data?.text
  );
  const prevTermNoId = await send<unknown>(asEditor, "POST", "/mail/preview", { kind: "termination", companyId: c2.id });
  ok("POST /mail/preview termination bez termId → 400", prevTermNoId.status === 400 && /wymaga wskazania warunków/.test(prevTermNoId.json.error ?? ""), prevTermNoId.json);
  const prevTerm = await send<{ subject: string; text: string; html: string; missing: string[] }>(asEditor, "POST", "/mail/preview", {
    kind: "termination",
    companyId: c2.id,
    termId: tB1.id,
  });
  ok(
    "POST /mail/preview termination z termId → obie daty podstawione",
    prevTerm.status === 200 && prevTerm.json.data?.text.includes("2020-01-01") === true && prevTerm.json.data.text.includes("2020-12-31") === true,
    prevTerm.json.data?.text
  );
  ok("POST /mail/preview: HTML ma szkielet maila (logo + stopka)", /alfa-logo-mail\.png/.test(prevTerm.json.data!.html) && /<!doctype html>/i.test(prevTerm.json.data!.html), prevTerm.json.data?.html.slice(0, 80));

  // Anty-XSS: nazwa firmy z kartoteki nie ma prawa wejść do HTML-a jako znacznik.
  const evil = (await send<CompanyJson>(asEditor, "POST", "/companies", { name: `${PREFIX} <script>alert(1)</script>` })).json.data!;
  const prevEvil = await send<{ html: string; text: string }>(asEditor, "POST", "/mail/preview", { kind: "termination", companyId: evil.id, termId: tB1.id });
  ok(
    "POST /mail/preview: nazwa firmy z HTML-em wychodzi zescapowana",
    prevEvil.json.data!.html.includes("&lt;script&gt;") && !prevEvil.json.data!.html.includes("<script>alert(1)"),
    prevEvil.json.data?.html.match(/.{0,40}script.{0,40}/)?.[0]
  );

  const sendNoTo = await send<unknown>(asEditor, "POST", "/mail/send", { kind: "rfq", companyId: c1.id, to: [] });
  ok("POST /mail/send bez adresata → 400", sendNoTo.status === 400 && /co najmniej jednego adresata/.test(sendNoTo.json.error ?? ""), sendNoTo.json);
  const sendBadTo = await send<unknown>(asEditor, "POST", "/mail/send", { kind: "rfq", companyId: c1.id, to: ["jan@"] });
  ok("POST /mail/send ze złym adresem → 400", sendBadTo.status === 400 && /Nieprawidłowe adresy/.test(sendBadTo.json.error ?? ""), sendBadTo.json);
  const sendTry = await send<{ logEntry: { id: number; variant: string | null; status: string } }>(asEditor, "POST", "/mail/send", {
    kind: "rfq",
    companyId: c1.id,
    objectId: objA.id,
    to: ["kontakt@alfa-interwencje.invalid"],
  });
  ok(
    "POST /mail/send przy wyłączonej wysyłce → 502 z wpisem dziennika",
    sendTry.status === 502 && sendTry.json.data?.logEntry?.status === "failed" && sendTry.json.data.logEntry.variant === "rfq",
    sendTry.json
  );
  const logged = db
    .select()
    .from(schema.mailLog)
    .where(and(eq(schema.mailLog.entityType, "intervention_group"), eq(schema.mailLog.entityId, c1.id)))
    .all();
  ok("mail_log: próba zapisana pod encją intervention_group", logged.length === 1 && logged[0].variant === "rfq", logged.map((l) => [l.variant, l.status]));
  const mailLogRoute = await get<{ items: { id: number }[] }>(asEditor, `/mail/log?companyId=${c1.id}`);
  ok("GET /mail/log?companyId= → wpis widoczny przez API", mailLogRoute.status === 200 && mailLogRoute.json.data?.items.length === 1, mailLogRoute.json.data?.items);

  // ======================================================== 7. ZAŁĄCZNIKI
  const attCompany = await upload<CompanyJson>(asEditor, `/companies/${c1.id}/attachments`, [
    { name: "umowa.PNG", type: "image/png", data: png },
    { name: "umowa-ramowa.pdf", type: "application/octet-stream", data: pdf },
  ]);
  const cAtts = attCompany.json.data?.attachments ?? [];
  const cImg = cAtts.find((a) => a.kind === "image")!;
  const cDoc = cAtts.find((a) => a.kind === "file")!;
  ok("POST /companies/:id/attachments → 200, obrazek → WebP z wymiarami", attCompany.status === 200 && cImg?.mimeType === "image/webp" && cImg.fileName === "umowa.webp" && cImg.width === 1200 && cImg.height === 600, cImg);
  ok("POST /companies/:id/attachments: PDF bez zmian, rozmiar surowy", cDoc?.mimeType === "application/pdf" && cDoc.size === pdf.length, cDoc);
  ok(
    "załącznik: url (inline) i downloadUrl pod trasą firmy",
    cImg.url === `/api/cma/intervention-groups/companies/${c1.id}/attachments/${cImg.id}/download?inline=1` &&
      cImg.downloadUrl === `/api/cma/intervention-groups/companies/${c1.id}/attachments/${cImg.id}/download`,
    { url: cImg.url, downloadUrl: cImg.downloadUrl }
  );
  const storedPath = db
    .select()
    .from(schema.interventionCompanyAttachments)
    .where(eq(schema.interventionCompanyAttachments.id, cImg.id))
    .get()?.storedPath;
  ok("załącznik: plik na dysku w scope interventions/companies/<id>/", !!storedPath && storedPath.startsWith(`interventions/companies/${c1.id}/`) && existsSync(resolveStoredPath(storedPath)!), storedPath);

  const dl = await asEditor.request(`${BASE}/companies/${c1.id}/attachments/${cDoc.id}/download`);
  ok(
    "GET .../download → 200, application/pdf, attachment, Content-Length",
    dl.status === 200 && dl.headers.get("content-type") === "application/pdf" && /^attachment;/.test(dl.headers.get("content-disposition") ?? "") && dl.headers.get("content-length") === String(pdf.length),
    Object.fromEntries(dl.headers)
  );
  ok("GET .../download → bajty PDF bez zmian", Buffer.from(await dl.arrayBuffer()).equals(pdf));
  const dlInline = await asEditor.request(`${BASE}/companies/${c1.id}/attachments/${cImg.id}/download?inline=1`);
  const inlineBody = Buffer.from(await dlInline.arrayBuffer());
  ok(
    "GET .../download?inline=1 → inline + treść WebP",
    dlInline.status === 200 && /^inline;/.test(dlInline.headers.get("content-disposition") ?? "") && inlineBody.subarray(8, 12).toString() === "WEBP",
    dlInline.headers.get("content-disposition")
  );
  const dlWrongOwner = await asEditor.request(`${BASE}/companies/${c2.id}/attachments/${cImg.id}/download`);
  ok("GET .../download z id cudzej firmy → 404", dlWrongOwner.status === 404);
  const attMissingOwner = await upload<CompanyJson>(asEditor, "/companies/99999999/attachments", [{ name: "x.txt", type: "text/plain", data: Buffer.from("a") }]);
  ok(
    "POST /companies/:id/attachments dla nieistniejącej firmy → 404 (bez katalogu na dysku)",
    attMissingOwner.status === 404 && !existsSync(join(ATTACHMENTS_DIR, "interventions", "companies", "99999999")),
    attMissingOwner.json
  );
  const attNoFiles = await upload<CompanyJson>(asEditor, `/companies/${c1.id}/attachments`, []);
  ok("POST /companies/:id/attachments bez plików → 400", attNoFiles.status === 400 && attNoFiles.json.error === "Nie wybrano plików", attNoFiles.json);
  const fill = await upload<CompanyJson>(
    asEditor,
    `/companies/${c2.id}/attachments`,
    Array.from({ length: 15 }, (_, i) => ({ name: `p${i}.txt`, type: "text/plain", data: Buffer.from("a") }))
  );
  ok("POST /companies/:id/attachments do 15 plików → 200", fill.status === 200 && fill.json.data?.attachments.length === 15, fill.json.data?.attachments.length);
  const over = await upload<CompanyJson>(asEditor, `/companies/${c2.id}/attachments`, [{ name: "za-duzo.txt", type: "text/plain", data: Buffer.from("a") }]);
  ok("POST /companies/:id/attachments 16. plik → 400", over.status === 400 && /Maksymalnie 15 plików na firmę \(jest już 15\)/.test(over.json.error ?? ""), over.json);

  const attTerm = await upload<TermJson>(asEditor, `/terms/${t1.id}/attachments`, [{ name: "umowa-obiekt.pdf", type: "application/pdf", data: pdf }]);
  ok("POST /terms/:id/attachments → 200, umowa przy warunkach", attTerm.status === 200 && attTerm.json.data?.attachments.length === 1, attTerm.json);
  const attInt = await upload<InterventionJson>(asEditor, `/interventions/${i3.id}/attachments`, [{ name: "zdjecie.png", type: "image/png", data: png }]);
  const intAtt = attInt.json.data?.attachments[0];
  ok(
    "POST /interventions/:id/attachments → 200, zdjęcie przy podjeździe (rozliczenie nietknięte)",
    attInt.status === 200 && intAtt?.kind === "image" && attInt.json.data?.seqInMonth === 3 && attInt.json.data.totalCost === 290,
    attInt.json
  );

  const delAtt = await send<{ id: number; companyId: number }>(asEditor, "DELETE", `/companies/${c1.id}/attachments/${cDoc.id}`);
  ok("DELETE załącznika → 200 { id, companyId }", delAtt.status === 200 && delAtt.json.data?.companyId === c1.id, delAtt.json);
  ok("DELETE załącznika: wiersz i plik znikają", !db.select().from(schema.interventionCompanyAttachments).where(eq(schema.interventionCompanyAttachments.id, cDoc.id)).get());
  const dlGone = await asEditor.request(`${BASE}/companies/${c1.id}/attachments/${cDoc.id}/download`);
  ok("GET .../download usuniętego załącznika → 404", dlGone.status === 404);

  // ======================================================== 8. UPRAWNIENIA
  const gStranger = await get<unknown>(asStranger, "/companies");
  ok("bez klucza cma/grupy-interwencyjne: GET → 403", gStranger.status === 403 && gStranger.json.error === "Brak dostępu do tej sekcji", gStranger.json);
  const gViewer = await get<{ items: CompanyJson[] }>(asViewer, "/companies");
  ok("„view”: GET → 200", gViewer.status === 200 && Array.isArray(gViewer.json.data?.items), gViewer.json);
  const pViewer = await send<unknown>(asViewer, "POST", "/companies", { name: `${PREFIX} nie wolno` });
  ok("„view”: POST → 403 („tryb tylko do odczytu”)", pViewer.status === 403 && /tylko do odczytu/.test(pViewer.json.error ?? ""), pViewer.json);
  const uViewer = await send<unknown>(asViewer, "PUT", `/companies/${c1.id}`, { active: false });
  ok("„view”: PUT → 403", uViewer.status === 403, uViewer.json);
  const dViewer = await send<unknown>(asViewer, "DELETE", `/terms/${tB2.id}`);
  ok("„view”: DELETE → 403", dViewer.status === 403, dViewer.json);
  const upViewer = await upload<unknown>(asViewer, `/companies/${c1.id}/attachments`, [{ name: "x.txt", type: "text/plain", data: Buffer.from("a") }]);
  ok("„view”: upload załącznika → 403", upViewer.status === 403, upViewer.json);
  const fileViewer = await asViewer.request(`${BASE}/companies/${c1.id}/attachments/${cImg.id}/download`);
  ok("„view”: pobranie załącznika → 200 (podgląd wolno)", fileViewer.status === 200);
  const gEditor = await get<{ items: CompanyJson[] }>(asEditor, "/companies");
  ok("„edit”: GET → 200", gEditor.status === 200);
  const gAdmin = await get<{ items: CompanyJson[] }>(asAdmin, "/companies");
  ok("admin: GET → 200", gAdmin.status === 200);

  // ============================== 9. KASOWANIE I KASKADA OBIEKTU
  const termDirBefore = join(ATTACHMENTS_DIR, "interventions", "terms", String(t1.id));
  const intDirBefore = join(ATTACHMENTS_DIR, "interventions", "interventions", String(i3.id));
  ok("przed usunięciem obiektu: katalogi warunków i interwencji istnieją", existsSync(termDirBefore) && existsSync(intDirBefore));

  const delInt = await send<{ id: number }>(asEditor, "DELETE", `/interventions/${i2.id}`);
  ok("DELETE /interventions/:id → 200", delInt.status === 200 && !db.select().from(schema.interventions).where(eq(schema.interventions.id, i2.id)).get(), delInt.json);
  const delIntAgain = await send<unknown>(asEditor, "DELETE", `/interventions/${i2.id}`);
  ok("DELETE /interventions/:id już usuniętej → 404", delIntAgain.status === 404);

  // Obiekt C: warunki bez interwencji — DELETE warunków i firmy po czyszczeniu.
  const tC = (await send<TermJson>(asEditor, "POST", "/terms", { objectId: objC.id, companyId: c1.id, startDate: "2026-01-01" })).json.data!;
  await upload<TermJson>(asEditor, `/terms/${tC.id}/attachments`, [{ name: "umowa-c.pdf", type: "application/pdf", data: pdf }]);
  const tCDir = join(ATTACHMENTS_DIR, "interventions", "terms", String(tC.id));
  ok("przed DELETE warunków: katalog istnieje", existsSync(tCDir));
  const delTerm = await send<{ id: number }>(asEditor, "DELETE", `/terms/${tC.id}`);
  ok("DELETE /terms/:id bez interwencji → 200 i katalog skasowany", delTerm.status === 200 && !existsSync(tCDir), delTerm.json);

  // Usunięcie OBIEKTU: kaskada FK czyści wiersze, hook w src/routes/objects.ts — katalogi.
  // Kasowanie obiektu to zakładka „objects” — wołamy jako admin (edytor grup jej nie ma).
  const delObject = await asAdmin.request(`/objects/${objA.id}`, { method: "DELETE" });
  ok("DELETE /objects/:id → 200", delObject.status === 200, await delObject.json());
  ok(
    "DELETE obiektu: warunki i interwencje znikają kaskadą",
    db.select().from(schema.interventionTerms).where(eq(schema.interventionTerms.objectId, objA.id)).all().length === 0 &&
      db.select().from(schema.interventions).where(eq(schema.interventions.objectId, objA.id)).all().length === 0
  );
  ok("DELETE obiektu: katalogi załączników warunków i interwencji skasowane", !existsSync(termDirBefore) && !existsSync(intDirBefore));

  // Firma bez warunków daje się skasować razem z katalogiem.
  const evilDel = await send<{ id: number }>(asEditor, "DELETE", `/companies/${evil.id}`);
  ok("DELETE /companies/:id bez warunków → 200", evilDel.status === 200 && !db.select().from(schema.interventionCompanies).where(eq(schema.interventionCompanies.id, evil.id)).get(), evilDel.json);
  const c2Dir = join(ATTACHMENTS_DIR, "interventions", "companies", String(c2.id));
  ok("przed DELETE firmy: katalog załączników istnieje", existsSync(c2Dir));
  await send<{ id: number }>(asEditor, "DELETE", `/terms/${tB1.id}`);
  await send<{ id: number }>(asEditor, "DELETE", `/terms/${tB2.id}`);
  const c2Del = await send<{ id: number }>(asEditor, "DELETE", `/companies/${c2.id}`);
  ok("DELETE /companies/:id → 200 i katalog załączników skasowany (rm -r)", c2Del.status === 200 && !existsSync(c2Dir), c2Del.json);
  const c2DelAgain = await send<unknown>(asEditor, "DELETE", `/companies/${c2.id}`);
  ok("DELETE /companies/:id już usuniętej → 404", c2DelAgain.status === 404);

  const logs = db
    .select()
    .from(schema.activityLog)
    .where(eq(schema.activityLog.entityType, "intervention_company"))
    .all();
  ok("activity_log: wpisy created/updated/deleted dla firm", ["created", "updated", "deleted"].every((a) => logs.some((l) => l.action === a)), logs.map((l) => l.action));
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} firm testowych)`);
}
console.log(failures ? `\n${failures} błędów` : "\nWszystko OK");
process.exit(failures ? 1 : 0);
