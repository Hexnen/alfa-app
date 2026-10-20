/**
 * Wąskie słowniki i redakcje z audytu uprawnień (docs/AUDYT-UPRAWNIEN-A.md, B.md)
 * — trasy Hono przez `app.request`, z podstawionym userem i PRAWDZIWYM
 * `tabPermissionGuard`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-catalog-perms.ts
 *   npx tsx scripts/test-catalog-perms.ts            # na data/alfa.db (sprząta po sobie)
 *
 * Sprawdza:
 *   • GET /objects/catalog — 200 dla kalendarzy/umów/realizacji, 403 na pełnym /objects,
 *     brak pól kwotowych, ?contractorId= zawęża, tylko do odczytu;
 *   • GET /salespeople/catalog — bez prowizji i portfela; pełne /salespeople tylko „handlowcy”;
 *   • GET /leads/pick — bez wartości szans; pełne /leads dalej zamknięte;
 *   • GET /leads/:id — offers[].totals bez kosztów/marży bez `technical/oferty-koszty`;
 *   • GET /calendar/pick/contacts|protocols|quotes|realizations — bramka działu, wąskie pola;
 *   • /technicians — zapis wyłącznie z `technical/technicy` (S1).
 */
import { Hono } from "hono";
import { eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import objectsRoutes from "../src/routes/objects.js";
import salespeopleRoutes from "../src/routes/salespeople.js";
import leadsRoutes from "../src/routes/leads.js";
import calendarRoutes from "../src/routes/calendar.js";
import techniciansRoutes from "../src/routes/technicians.js";
import contractorsRoutes from "../src/routes/contractors.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)?.slice(0, 400)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__CATPERM__";
const NIP = "9999999917"; // fikcyjny, unikalny dla testu

function cleanup() {
  const contractorIds = db
    .select({ id: schema.contractors.id })
    .from(schema.contractors)
    .where(like(schema.contractors.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const leadIds = db
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(like(schema.leads.title, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (leadIds.length) {
    db.delete(schema.offers).where(inArray(schema.offers.leadId, leadIds)).run();
    db.delete(schema.contacts).where(inArray(schema.contacts.leadId, leadIds)).run();
    db.delete(schema.activityLog).where(inArray(schema.activityLog.entityId, leadIds)).run();
    db.delete(schema.leads).where(inArray(schema.leads.id, leadIds)).run();
  }
  if (contractorIds.length) {
    db.delete(schema.contacts).where(inArray(schema.contacts.contractorId, contractorIds)).run();
    db.delete(schema.objects).where(inArray(schema.objects.contractorId, contractorIds)).run();
    db.delete(schema.contractors).where(inArray(schema.contractors.id, contractorIds)).run();
  }
  db.delete(schema.salespeople).where(like(schema.salespeople.lastName, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
}
cleanup();

function makeUser(suffix: string, permissions: PermissionMap): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x",
      displayName: `${PREFIX}${suffix}`,
      role: "user",
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .get();
}

type Res = { status: number; success?: boolean; data?: unknown; error?: string };

function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/api/objects", objectsRoutes);
  app.route("/api/salespeople", salespeopleRoutes);
  app.route("/api/leads", leadsRoutes);
  app.route("/api/calendar", calendarRoutes);
  app.route("/api/technicians", techniciansRoutes);
  app.route("/api/contractors", contractorsRoutes);
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as Omit<Res, "status"> | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

const arr = (r: Res) => (Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : []);
const hasAnyKey = (rows: Record<string, unknown>[], keys: string[]) =>
  rows.some((row) => keys.some((k) => k in row));

try {
  // ------------------------------------------------------------------ fikstury
  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Klient`, nip: NIP })
    .returning()
    .get();
  const object = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX}Obiekt`,
      address: "ul. Testowa 1",
      city: "Testowo",
      type: "monitoring",
      installationType: "new",
      monthlyZdw: 1234,
      monthlyCost: 567,
      setupCost: 890,
    })
    .returning()
    .get();
  const sp = db
    .insert(schema.salespeople)
    .values({ firstName: "Jan", lastName: `${PREFIX}Handlowiec`, commissionRate: 7, monthlyCost: 9000 })
    .returning()
    .get();
  const lead = db
    .insert(schema.leads)
    .values({
      title: `${PREFIX}Szansa`,
      contractorId: contractor.id,
      salespersonId: sp.id,
      estimatedMonthly: 4321,
      estimatedSetup: 8765,
    })
    .returning()
    .get();
  const contactLead = db
    .insert(schema.contacts)
    .values({ leadId: lead.id, firstName: "Ala", lastName: `${PREFIX}Kontakt`, notes: "tajne" })
    .returning()
    .get();
  const contactContractor = db
    .insert(schema.contacts)
    .values({ contractorId: contractor.id, firstName: "Ola", lastName: `${PREFIX}KontaktKlienta` })
    .returning()
    .get();
  db.insert(schema.offers)
    .values({ number: `${PREFIX}OF-1`, date: "2026-10-20", leadId: lead.id })
    .run();

  const techCal = clientFor(makeUser("techcal", { "technical/kalendarz": "edit" }));
  const salesCal = clientFor(makeUser("salescal", { "handlowy/kalendarz": "edit" }));
  const contracts = clientFor(makeUser("contracts", { contracts: "edit" }));
  const realiz = clientFor(makeUser("realiz", { "technical/realizacje": "edit" }));
  const leadsView = clientFor(makeUser("leads", { "handlowy/leady": "view" }));
  const leadsCost = clientFor(makeUser("leadscost", { "handlowy/leady": "view", "technical/oferty-koszty": "view" }));
  const handlowcy = clientFor(makeUser("handlowcy", { handlowcy: "view" }));
  const technicy = clientFor(makeUser("technicy", { "technical/technicy": "edit" }));
  const none = clientFor(makeUser("none", { "cma/raporty": "view" }));

  const MONEY = ["monthlyZdw", "monthlyOfi", "monthlyRental", "monthlyCost", "setupCost", "monthlyValue", "services"];

  // ------------------------------------------------------------------ /objects/catalog
  for (const [label, client] of [
    ["technical/kalendarz", techCal],
    ["handlowy/kalendarz", salesCal],
    ["contracts", contracts],
    ["technical/realizacje", realiz],
  ] as const) {
    const cat = await client("GET", "/objects/catalog");
    ok(`${label}: GET /objects/catalog → 200`, cat.status === 200, cat);
    const mine = arr(cat).find((o) => o.id === object.id);
    ok(`${label}: katalog zawiera obiekt z adresem i kontrahentem`, !!mine && mine.address === "ul. Testowa 1" &&
      (mine.contractor as { name?: string } | undefined)?.name === contractor.name && mine.contractorId === contractor.id, mine);
    ok(`${label}: katalog BEZ pól kwotowych`, !hasAnyKey(arr(cat), MONEY), arr(cat)[0]);
    ok(`${label}: GET /objects (pełna kartoteka) → 403`, (await client("GET", "/objects")).status === 403);
    ok(`${label}: GET /objects/:id → 403`, (await client("GET", `/objects/${object.id}`)).status === 403);
  }
  const filtered = await techCal("GET", `/objects/catalog?contractorId=${contractor.id}`);
  ok("?contractorId= zawęża do obiektów kontrahenta", arr(filtered).length === 1 && arr(filtered)[0].id === object.id, filtered);
  ok("?contractorId=abc → 400", (await techCal("GET", "/objects/catalog?contractorId=abc")).status === 400);
  ok("katalog obiektów tylko do odczytu: POST → 403", (await techCal("POST", "/objects/catalog", {})).status === 403);
  ok("klucz spoza listy (cma/raporty): /objects/catalog → 403", (await none("GET", "/objects/catalog")).status === 403);

  // ------------------------------------------------------------------ /contractors/catalog dla Umów
  ok("contracts: GET /contractors/catalog → 200", (await contracts("GET", "/contractors/catalog")).status === 200);
  ok("contracts: GET /contractors → 403", (await contracts("GET", "/contractors")).status === 403);

  // ------------------------------------------------------------------ /salespeople/catalog
  const spCat = await salesCal("GET", "/salespeople/catalog");
  ok("handlowy/kalendarz: GET /salespeople/catalog → 200", spCat.status === 200, spCat);
  const spRow = arr(spCat).find((r) => r.id === sp.id);
  ok("katalog handlowców zawiera nazwisko", !!spRow && spRow.lastName === sp.lastName, spRow);
  ok(
    "katalog handlowców BEZ prowizji, kosztu i portfela",
    !hasAnyKey(arr(spCat), ["commissionRate", "monthlyCost", "objectsMonthlyValue", "objectsMonthlyCost", "objectsSetupCost", "email", "phone"]),
    spRow
  );
  ok("handlowy/kalendarz: GET /salespeople (pełna lista) → 403", (await salesCal("GET", "/salespeople")).status === 403);
  ok("handlowcy: GET /salespeople → 200", (await handlowcy("GET", "/salespeople")).status === 200);
  ok("katalog handlowców tylko do odczytu: POST → 403", (await salesCal("POST", "/salespeople/catalog", {})).status === 403);
  ok("technical/kalendarz: GET /salespeople/catalog → 403", (await techCal("GET", "/salespeople/catalog")).status === 403);

  // ------------------------------------------------------------------ /leads/pick
  const pick = await salesCal("GET", `/leads/pick?q=${encodeURIComponent(PREFIX)}`);
  ok("handlowy/kalendarz: GET /leads/pick → 200", pick.status === 200, pick);
  const pickRow = arr(pick).find((r) => r.id === lead.id);
  ok("pick zwraca szansę z kontrahentem i handlowcem", !!pickRow && pickRow.contractorId === contractor.id && pickRow.salespersonId === sp.id, pickRow);
  ok(
    "pick BEZ wartości szans i danych prospektu",
    !hasAnyKey(arr(pick), ["estimatedMonthly", "estimatedSetup", "probability", "notes", "prospectPhone", "offers"]),
    pickRow
  );
  const byId = await salesCal("GET", `/leads/pick?id=${lead.id}`);
  ok("pick ?id= zwraca jedną szansę", arr(byId).length === 1 && arr(byId)[0].id === lead.id, byId);
  ok("handlowy/kalendarz: GET /leads → 403", (await salesCal("GET", "/leads")).status === 403);
  ok("handlowy/kalendarz: GET /leads/:id → 403", (await salesCal("GET", `/leads/${lead.id}`)).status === 403);
  ok("technical/kalendarz: GET /leads/pick → 403", (await techCal("GET", "/leads/pick")).status === 403);

  // ------------------------------------------------------------------ /leads/:id — redakcja kosztów ofert
  const card = await leadsView("GET", `/leads/${lead.id}`);
  const offers = ((card.data as { offers?: Record<string, unknown>[] } | undefined)?.offers ?? []);
  const totals = (offers[0]?.totals ?? {}) as Record<string, unknown>;
  ok("handlowy/leady: karta szansy → 200 z ofertą", card.status === 200 && offers.length === 1, card.status);
  ok("bez oferty-koszty: totals BEZ kosztów i marży",
    !["oneTimeCost", "monthlyCost", "horizonCost", "margin", "belowMinMargin"].some((k) => k in totals), totals);
  ok("bez oferty-koszty: totals dalej ma sumy sprzedaży", "monthlyTotal" in totals || "oneTimeTotal" in totals, totals);
  const cardCost = await leadsCost("GET", `/leads/${lead.id}`);
  const totalsCost = (((cardCost.data as { offers?: Record<string, unknown>[] }).offers ?? [])[0]?.totals ?? {}) as Record<string, unknown>;
  ok("z oferty-koszty: totals z kosztami i marżą", "margin" in totalsCost && "oneTimeCost" in totalsCost, totalsCost);

  // ------------------------------------------------------------------ /calendar/pick/contacts
  const contacts = await salesCal("GET", `/calendar/pick/contacts?leadId=${lead.id}`);
  ok("handlowy/kalendarz: GET /calendar/pick/contacts → 200", contacts.status === 200, contacts);
  const ids = arr(contacts).map((r) => r.id);
  ok("kontakty szansy + jej kontrahenta", ids.includes(contactLead.id) && ids.includes(contactContractor.id), ids);
  ok("kontakty BEZ notatek i metadanych", !hasAnyKey(arr(contacts), ["notes", "createdBy", "createdAt"]), arr(contacts)[0]);
  ok("technical/kalendarz: /calendar/pick/contacts → 403", (await techCal("GET", `/calendar/pick/contacts?leadId=${lead.id}`)).status === 403);
  ok("zły leadId → 400", (await salesCal("GET", "/calendar/pick/contacts?leadId=x")).status === 400);

  // ------------------------------------------------------------------ /calendar/pick/{protocols,quotes,realizations}
  const prot = await techCal("GET", "/calendar/pick/protocols?limit=5");
  ok("technical/kalendarz: /calendar/pick/protocols → 200", prot.status === 200, prot);
  ok("protokoły BEZ pozycji i podpisu", !hasAnyKey(arr(prot), ["items", "signature", "signatureData", "notes"]), arr(prot)[0]);
  const quotes = await techCal("GET", "/calendar/pick/quotes?limit=5");
  ok("technical/kalendarz: /calendar/pick/quotes → 200", quotes.status === 200, quotes);
  ok("wyceny BEZ pozycji (cen jednostkowych)", !hasAnyKey(arr(quotes), ["items"]), arr(quotes)[0]);
  const real = await techCal("GET", "/calendar/pick/realizations?year=2026&month=10");
  ok("technical/kalendarz: /calendar/pick/realizations → 200", real.status === 200, real);
  ok("realizacje BEZ kosztów i rzeczywistych godzin",
    !hasAnyKey(arr(real), ["hourlyCost", "actualHours", "actualKm", "amountHours", "amountMaterial"]), arr(real)[0]);
  ok("realizacje bez year/month → 400", (await techCal("GET", "/calendar/pick/realizations")).status === 400);
  ok("handlowy/kalendarz: /calendar/pick/protocols → 403", (await salesCal("GET", "/calendar/pick/protocols")).status === 403);
  ok("handlowy/kalendarz: /calendar/pick/quotes → 403", (await salesCal("GET", "/calendar/pick/quotes")).status === 403);

  // ------------------------------------------------------------------ /technicians — zapis (S1)
  ok("technical/kalendarz: GET /technicians → 200", (await techCal("GET", "/technicians")).status === 200);
  ok("technical/kalendarz:edit: POST /technicians → 403", (await techCal("POST", "/technicians", {})).status === 403);
  ok("technical/kalendarz:edit: PUT /technicians/1 → 403", (await techCal("PUT", "/technicians/1", {})).status === 403);
  ok("technical/kalendarz:edit: DELETE /technicians/999999 → 403", (await techCal("DELETE", "/technicians/999999")).status === 403);
  const techPost = await technicy("POST", "/technicians", {});
  ok("technical/technicy:edit: POST /technicians przechodzi bramkę (400 walidacji, nie 403)", techPost.status === 400, techPost);
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
