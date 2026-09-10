/**
 * SZANSA → ZLECENIE → OFERTA (§3.4 planu „Handlowy”). Routery `/leads`, `/orders`,
 * `/offers` i publiczny `/public` przez `app.request`, z podstawionym userem
 * w kontekście i PRAWDZIWYM `tabPermissionGuard`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-lead-order.ts
 *   npx tsx scripts/test-lead-order.ts        # na data/alfa.db (sprząta po sobie)
 *
 * Co jest tu pilnowane:
 *   • `GET /leads/:id/order-prefill` — płatnik z kartoteki kontrahenta, zlecający
 *     i kontakt z GŁÓWNEJ osoby kontaktowej, usługi mapowane na obiektowe
 *     („ochrona” → „ofi”), abonament z `estimatedMonthly`,
 *   • `POST /orders` z `leadId` — linkuje w OBIE strony (`orders.lead_id`
 *     i `leads.order_id`), dziedziczy handlowca z szansy, przesuwa
 *     `last_activity_at` i dopisuje `linked` do dziennika szansy,
 *   • DRUGIE zlecenie z tej samej szansy → 409, a szansa zostaje nietknięta,
 *   • `GET /orders?salespersonId=&leadId=` — filtry + `salespersonName`/`leadTitle`,
 *   • usunięta szansa → 400 (zlecenie nie powstaje),
 *   • publiczny formularz ZDW z PODRZUCONYM `leadId` — zlecenie powstaje, ale
 *     lejek jest nietknięty (`leads.order_id` dalej puste, brak wpisu w dzienniku),
 *   • oferta: `leadId` w create/list/detail + prefill klienta i handlowca z szansy,
 *     `GET /offers?leadId=`, a po akceptacji wpis `linked` na szansie BEZ zmiany
 *     etapu (etap zamyka handlowiec, nie kliknięcie w Ofertach).
 *
 * Sprząta po sobie HARD (zlecenia, oferty, szanse, kontakty, obiekty, kontrahenci,
 * handlowcy, konta, dziennik), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import leadsRoutes from "../src/routes/leads.js";
import contactsRoutes from "../src/routes/contacts.js";
import ordersRoutes from "../src/routes/orders.js";
import offersRoutes from "../src/routes/offers.js";
import publicRoutes from "../src/routes/public.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import { validateNIP } from "../src/utils/nip.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__LEADORDER_TEST__";

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): void {
  const leadIds = db
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(like(schema.leads.title, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);

  // Zlecenia: te z naszych szans ORAZ te z migawką nazwy obiektu (publiczny
  // formularz szansy nie ma, więc po `lead_id` byśmy go nie znaleźli).
  const orderIds = db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(
      leadIds.length
        ? or(like(schema.orders.objectName, `%${PREFIX}%`), inArray(schema.orders.leadId, leadIds))
        : like(schema.orders.objectName, `%${PREFIX}%`)
    )
    .all()
    .map((r) => r.id);

  const offerIds = db
    .select({ id: schema.offers.id })
    .from(schema.offers)
    .where(
      leadIds.length
        ? or(like(schema.offers.site, `%${PREFIX}%`), inArray(schema.offers.leadId, leadIds))
        : like(schema.offers.site, `%${PREFIX}%`)
    )
    .all()
    .map((r) => r.id);

  if (offerIds.length) {
    db.delete(schema.offerTextBlocks).where(inArray(schema.offerTextBlocks.offerId, offerIds)).run();
    db.delete(schema.offerItems).where(inArray(schema.offerItems.offerId, offerIds)).run();
    db.delete(schema.offerSections).where(inArray(schema.offerSections.offerId, offerIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "offer"), inArray(schema.activityLog.entityId, offerIds)))
      .run();
    db.delete(schema.offers).where(inArray(schema.offers.id, offerIds)).run();
  }

  // Szansa wskazuje zlecenie (FK) — odpinamy, zanim skasujemy zlecenia.
  if (leadIds.length) {
    db.update(schema.leads).set({ orderId: null }).where(inArray(schema.leads.id, leadIds)).run();
  }
  if (orderIds.length) {
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "order"), inArray(schema.activityLog.entityId, orderIds)))
      .run();
    db.delete(schema.orders).where(inArray(schema.orders.id, orderIds)).run();
  }
  if (leadIds.length) {
    db.delete(schema.contacts).where(inArray(schema.contacts.leadId, leadIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "lead"), inArray(schema.activityLog.entityId, leadIds)))
      .run();
    db.delete(schema.leads).where(inArray(schema.leads.id, leadIds)).run();
  }

  const contractorIds = db
    .select({ id: schema.contractors.id })
    .from(schema.contractors)
    .where(like(schema.contractors.name, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (contractorIds.length) {
    const objIds = db
      .select({ id: schema.objects.id })
      .from(schema.objects)
      .where(inArray(schema.objects.contractorId, contractorIds))
      .all()
      .map((r) => r.id);
    if (objIds.length) {
      db.delete(schema.objectHistory).where(inArray(schema.objectHistory.objectId, objIds)).run();
      db.delete(schema.objectServices).where(inArray(schema.objectServices.objectId, objIds)).run();
      db.delete(schema.orders).where(inArray(schema.orders.objectId, objIds)).run();
      db.delete(schema.objects).where(inArray(schema.objects.id, objIds)).run();
    }
    db.delete(schema.contacts).where(inArray(schema.contacts.contractorId, contractorIds)).run();
    db.delete(schema.contractors).where(inArray(schema.contractors.id, contractorIds)).run();
  }
  db.delete(schema.salespeople).where(like(schema.salespeople.lastName, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
}
cleanup();

// ---------------------------------------------------------------------------
// Fikstury
// ---------------------------------------------------------------------------

function makeUser(suffix: string, permissions: PermissionMap): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x", // konto nigdy się nie loguje — kontekst podstawiamy wprost
      displayName: `${PREFIX}${suffix}`,
      role: "user",
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .get();
}

type Res = { status: number; success?: boolean; data?: unknown; error?: string; message?: string };

/** Klient HTTP dla usera: kontekst jak po requireAuth + prawdziwy strażnik zakładek. */
function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/api/leads", leadsRoutes);
  app.route("/api/contacts", contactsRoutes);
  app.route("/api/orders", ordersRoutes);
  app.route("/api/offers", offersRoutes);
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as Omit<Res, "status"> | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/** Publiczny formularz ZDW — BEZ usera i BEZ strażnika, dokładnie jak w `routes/index.ts`. */
const publicApp = new Hono();
publicApp.route("/api/public", publicRoutes);
async function P(path: string, body: unknown): Promise<Res> {
  const res = await publicApp.request(`/api/public${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const json = (await res.json().catch(() => null)) as Omit<Res, "status"> | null;
  return { status: res.status, ...(json ?? {}) };
}

/** NIP z poprawną sumą kontrolną, którego NIE ma jeszcze w kartotece. */
const usedNips = new Set<string>();
function freshNip(): string {
  for (let base = 1_000_000_00; base < 1_000_500_00; base++) {
    for (let check = 0; check <= 9; check++) {
      const nip = `${base}${check}`;
      if (nip.length !== 10 || !validateNIP(nip) || usedNips.has(nip)) continue;
      const exists = db
        .select({ id: schema.contractors.id })
        .from(schema.contractors)
        .where(eq(schema.contractors.nip, nip))
        .get();
      if (!exists) {
        usedNips.add(nip);
        return nip;
      }
    }
  }
  throw new Error("Nie udało się wygenerować wolnego NIP-u");
}

const salesUser = makeUser("sales", {
  "handlowy/leady": "edit",
  "handlowy/kontakty": "edit",
  orders: "edit",
  "technical/oferty": "edit",
});
const S = clientFor(salesUser);

const salesperson = db
  .insert(schema.salespeople)
  .values({ firstName: "Anna", lastName: `${PREFIX}Kowalska`, userId: salesUser.id })
  .returning()
  .get();

const leadNip = freshNip();
const contractor = db
  .insert(schema.contractors)
  .values({
    name: `${PREFIX} Klient sp. z o.o.`,
    nip: leadNip,
    email: "faktury@example.invalid",
    phone: "500100200",
    contactPerson: "Ktoś z kartoteki",
  })
  .returning()
  .get();

const dataOf = <T>(r: Res) => r.data as T;

/** Wpisy dziennika szansy — po nich sprawdzamy „Utworzono zlecenie … z szansy”. */
function leadLog(leadId: number) {
  return db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "lead"), eq(schema.activityLog.entityId, leadId)))
    .all();
}

function leadRow(id: number) {
  return db.select().from(schema.leads).where(eq(schema.leads.id, id)).get()!;
}

try {
  // =========================================================================
  // 1. Szansa z kontrahentem i osobą kontaktową → prefill formularza zlecenia
  // =========================================================================
  const created = await S("POST", "/leads", {
    title: `${PREFIX} Biurowiec Centrum`,
    stage: "oferta",
    contractorId: contractor.id,
    city: "Katowice",
    address: "ul. Testowa 1",
    objectKind: "Biurowiec",
    services: ["kamery", "ochrona"],
    estimatedMonthly: 1500,
    salespersonId: salesperson.id,
  });
  ok("POST /leads → 201", created.status === 201, created);
  const leadId = dataOf<{ id: number }>(created).id;

  // Dwie osoby: „główna” ma wygrać z pierwszą z listy.
  await S("POST", "/contacts", {
    contractorId: contractor.id,
    firstName: "Zenon",
    lastName: `${PREFIX}Poboczny`,
    phone: "601000001",
    email: "zenon@example.invalid",
  });
  const primary = await S("POST", "/contacts", {
    contractorId: contractor.id,
    leadId,
    firstName: "Maria",
    lastName: `${PREFIX}Główna`,
    role: "Kierownik obiektu",
    phone: "601202303",
    email: "maria@example.invalid",
    isPrimary: true,
  });
  ok("POST /contacts (główna) → 201", primary.status === 201, primary);

  const prefillRes = await S("GET", `/leads/${leadId}/order-prefill`);
  const pf = dataOf<{
    leadId: number;
    leadTitle: string;
    leadOrderId: number | null;
    salespersonId: number | null;
    payerContractorId: number | null;
    payerName: string;
    payerNip: string;
    requesterName: string;
    requesterPhone: string;
    contactPerson: string;
    contactPhone: string;
    objectName: string;
    objectCity: string;
    objectKind: string;
    objectLocationUrl: string;
    payerInvoiceEmail: string;
    monthlyAmount: string;
    isCameraInstallation: boolean;
    interventionGroup: boolean;
    objectServices: { service: string; startDate: string }[];
  }>(prefillRes);
  ok("order-prefill → 200", prefillRes.status === 200, prefillRes);
  ok("prefill: płatnik z kartoteki kontrahenta", pf.payerNip === leadNip && pf.payerName.includes(PREFIX), pf);
  ok("prefill: kontrahent podpięty, nie do założenia", pf.payerContractorId === contractor.id, pf);
  ok("prefill: zlecający z GŁÓWNEJ osoby kontaktowej", pf.requesterName === `Maria ${PREFIX}Główna`, pf);
  ok("prefill: telefon kontaktu z osoby głównej", pf.contactPhone === "601202303" && pf.requesterPhone === "601202303", pf);
  ok("prefill: obiekt z szansy", pf.objectName.includes(PREFIX) && pf.objectCity === "Katowice" && pf.objectKind === "Biurowiec", pf);
  ok("prefill: abonament z estimatedMonthly", pf.monthlyAmount === "1500", pf);
  ok("prefill: handlowiec z szansy", pf.salespersonId === salesperson.id, pf);
  ok("prefill: szansa jeszcze bez zlecenia", pf.leadOrderId === null, pf);
  ok(
    "prefill: usługi mapowane na obiektowe (ochrona → ofi)",
    pf.objectServices.map((s) => s.service).sort().join() === "kamery,ofi",
    pf.objectServices
  );
  ok("prefill: montaż kamer i grupa interwencyjna z usług", pf.isCameraInstallation && pf.interventionGroup, pf);
  ok("prefill: e-mail do faktur z kartoteki kontrahenta", pf.payerInvoiceEmail === "faktury@example.invalid", pf);
  ok("prefill: szansa bez obiektu i bez pinezki → pusty link lokalizacji", pf.objectLocationUrl === "", pf);

  // =========================================================================
  // 2. POST /orders z leadId — link w obie strony + wpis w dzienniku
  // =========================================================================
  const orderBody = {
    requesterName: pf.requesterName,
    requesterPhone: pf.requesterPhone,
    requesterEmail: "maria@example.invalid",
    payerName: pf.payerName,
    payerNip: pf.payerNip,
    payerContractorId: pf.payerContractorId,
    createContractor: false,
    objectName: pf.objectName,
    objectAddress: "ul. Testowa 1",
    objectCity: "Katowice",
    contactPerson: pf.contactPerson,
    contactPhone: pf.contactPhone,
    createObject: true,
    objectInstallationType: "new",
    objectServices: pf.objectServices,
    monthlyAmount: 1500,
    leadId,
  };
  const orderRes = await S("POST", "/orders", orderBody);
  ok("POST /orders z leadId → 201", orderRes.status === 201, orderRes);
  const order = dataOf<{ id: number; orderNumber: string; leadId: number | null; salespersonId: number | null; objectId: number }>(orderRes);
  ok("zlecenie niesie lead_id", order.leadId === leadId, order);
  ok("zlecenie dziedziczy handlowca z szansy", order.salespersonId === salesperson.id, order);

  const linkedLead = leadRow(leadId);
  ok("szansa dostała order_id", linkedLead.orderId === order.id, linkedLead);
  ok("szansa dostała obiekt ze zlecenia", linkedLead.objectId === order.objectId, linkedLead);
  ok("szansa ma przesunięty last_activity_at", !!linkedLead.lastActivityAt, linkedLead);

  const log = leadLog(leadId);
  const linkEntry = log.find((e) => e.action === "linked" && (e.summary ?? "").includes("Utworzono zlecenie"));
  ok("dziennik szansy: wpis `linked` o zleceniu", !!linkEntry, log.map((e) => `${e.action}: ${e.summary}`));
  ok(
    "wpis niesie numer zlecenia",
    !!linkEntry && (linkEntry.summary ?? "").includes(order.orderNumber),
    linkEntry?.summary
  );

  // =========================================================================
  // 2b. Prefill po konwersji: lokalizacja z KARTOTEKI obiektu
  // =========================================================================
  // Szansa nie ma własnej pinezki, ale ma już obiekt — link musi przyjść stamtąd,
  // inaczej zlecenie idzie do techników bez lokalizacji, choć kartoteka ją zna.
  {
    const mapsUrl = "https://www.google.com/maps/place/Testowa+1";
    db.update(schema.objects).set({ mapsUrl }).where(eq(schema.objects.id, order.objectId)).run();
    const fromObject = dataOf<{ objectLocationUrl: string }>(await S("GET", `/leads/${leadId}/order-prefill`));
    ok("prefill: link lokalizacji z `objects.maps_url`", fromObject.objectLocationUrl === mapsUrl, fromObject);

    // Bez linku, ale ze współrzędnymi — składamy adres Map z lat/lng.
    db.update(schema.objects)
      .set({ mapsUrl: null, latitude: 50.2649, longitude: 19.0238 })
      .where(eq(schema.objects.id, order.objectId))
      .run();
    const fromCoords = dataOf<{ objectLocationUrl: string }>(await S("GET", `/leads/${leadId}/order-prefill`));
    ok(
      "prefill: link lokalizacji złożony ze współrzędnych obiektu",
      fromCoords.objectLocationUrl === "https://www.google.com/maps?q=50.2649,19.0238",
      fromCoords
    );

    // Pinezka wpisana w szansie ma pierwszeństwo przed kartoteką.
    const leadMaps = "https://maps.google.com/?q=51.1,17.03";
    db.update(schema.leads).set({ mapsUrl: leadMaps }).where(eq(schema.leads.id, leadId)).run();
    const fromLead = dataOf<{ objectLocationUrl: string }>(await S("GET", `/leads/${leadId}/order-prefill`));
    ok("prefill: pinezka szansy wygrywa z kartoteką obiektu", fromLead.objectLocationUrl === leadMaps, fromLead);
    db.update(schema.leads).set({ mapsUrl: null }).where(eq(schema.leads.id, leadId)).run();
  }

  // =========================================================================
  // 3. Drugie zlecenie z tej samej szansy → 409, szansa nietknięta
  // =========================================================================
  const secondRes = await S("POST", "/orders", { ...orderBody, objectName: `${PREFIX} Drugi obiekt` });
  ok("drugie zlecenie z tej samej szansy → 409", secondRes.status === 409, secondRes);
  ok("szansa dalej wskazuje pierwsze zlecenie", leadRow(leadId).orderId === order.id, leadRow(leadId));
  ok(
    "nieudana próba nie zostawiła obiektu",
    !db.select().from(schema.objects).where(eq(schema.objects.name, `${PREFIX} Drugi obiekt`)).get(),
    "obiekt z odrzuconej transakcji został w bazie"
  );

  // =========================================================================
  // 4. Filtry i etykiety na liście zleceń
  // =========================================================================
  const byLead = await S("GET", `/orders?leadId=${leadId}`);
  const leadOrders = dataOf<{ id: number; leadTitle: string | null; salespersonName: string | null }[]>(byLead);
  ok("GET /orders?leadId → tylko zlecenie tej szansy", leadOrders.length === 1 && leadOrders[0].id === order.id, leadOrders);
  ok("lista niesie leadTitle", (leadOrders[0]?.leadTitle ?? "").includes(PREFIX), leadOrders[0]);
  ok("lista niesie salespersonName", leadOrders[0]?.salespersonName === `Anna ${PREFIX}Kowalska`, leadOrders[0]);

  const bySales = await S("GET", `/orders?salespersonId=${salesperson.id}`);
  ok(
    "GET /orders?salespersonId → łapie zlecenie",
    dataOf<{ id: number }[]>(bySales).some((o) => o.id === order.id),
    dataOf<{ id: number }[]>(bySales).map((o) => o.id)
  );
  const noSales = await S("GET", "/orders?salespersonId=none");
  ok(
    "GET /orders?salespersonId=none → bez naszego zlecenia",
    !dataOf<{ id: number }[]>(noSales).some((o) => o.id === order.id),
    "zlecenie z handlowcem wpadło do „bez handlowca”"
  );

  const detail = await S("GET", `/orders/${order.id}`);
  const detailData = dataOf<{ leadId: number | null; leadTitle: string | null; salespersonName: string | null }>(detail);
  ok(
    "GET /orders/:id niesie szansę i handlowca",
    detailData.leadId === leadId &&
      (detailData.leadTitle ?? "").includes(PREFIX) &&
      detailData.salespersonName === `Anna ${PREFIX}Kowalska`,
    detailData
  );

  // =========================================================================
  // 5. Szansa usunięta / nieistniejąca → zlecenie nie powstaje
  // =========================================================================
  const ghost = await S("POST", "/leads", { title: `${PREFIX} Duch`, salespersonId: salesperson.id });
  const ghostId = dataOf<{ id: number }>(ghost).id;
  await S("DELETE", `/leads/${ghostId}`);
  const ghostNip = freshNip();
  const ghostOrder = await S("POST", "/orders", {
    ...orderBody,
    payerContractorId: undefined,
    createContractor: true,
    payerName: `${PREFIX} Duch sp. z o.o.`,
    payerNip: ghostNip,
    objectName: `${PREFIX} Obiekt ducha`,
    leadId: ghostId,
  });
  ok("zlecenie z usuniętej szansy → 400", ghostOrder.status === 400, ghostOrder);
  ok(
    "odrzucone zlecenie nie założyło kontrahenta",
    !db.select().from(schema.contractors).where(eq(schema.contractors.nip, ghostNip)).get(),
    "kontrahent z odrzuconej transakcji został w bazie"
  );

  // =========================================================================
  // 6. Publiczny formularz z PODRZUCONYM leadId — lejek nietknięty
  // =========================================================================
  const publicLead = await S("POST", "/leads", {
    title: `${PREFIX} Cudza szansa`,
    salespersonId: salesperson.id,
  });
  const publicLeadId = dataOf<{ id: number }>(publicLead).id;
  const publicNip = freshNip();
  const publicRes = await P("/order-intake", {
    requesterName: "Anonim z internetu",
    requesterPhone: "600100100",
    requesterEmail: "anonim@example.invalid",
    payerName: `${PREFIX} Firma z formularza`,
    payerNip: publicNip,
    objectName: `${PREFIX} Obiekt z formularza`,
    contactPerson: "Anonim z internetu",
    contactPhone: "600100100",
    isCameraInstallation: true,
    // Wstrzyknięcie: pola, których publiczny formularz nie ma prawa ustawić.
    leadId: publicLeadId,
    salespersonId: salesperson.id,
  });
  ok("publiczny formularz → 200/201", publicRes.status === 200 || publicRes.status === 201, publicRes);
  const publicOrder = db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.objectName, `${PREFIX} Obiekt z formularza`))
    .get();
  ok("publiczne zlecenie powstało", !!publicOrder, publicRes);
  ok("publiczne zlecenie NIE ma lead_id", publicOrder?.leadId === null, publicOrder);
  ok("publiczne zlecenie NIE ma handlowca", publicOrder?.salespersonId === null, publicOrder);
  ok("podrzucona szansa bez order_id", leadRow(publicLeadId).orderId === null, leadRow(publicLeadId));
  ok("podrzucona szansa bez wpisu w dzienniku", leadLog(publicLeadId).every((e) => e.action !== "linked"), leadLog(publicLeadId));

  // =========================================================================
  // 7. Oferta z szansy: prefill, filtr, akceptacja
  // =========================================================================
  const offerLead = await S("POST", "/leads", {
    title: `${PREFIX} Szansa na ofertę`,
    stage: "oferta",
    contractorId: contractor.id,
    address: "ul. Ofertowa 7",
    city: "Gliwice",
    salespersonId: salesperson.id,
  });
  const offerLeadId = dataOf<{ id: number }>(offerLead).id;

  const offerRes = await S("POST", "/offers", {
    date: new Date().toISOString().slice(0, 10),
    leadId: offerLeadId,
  });
  ok("POST /offers z leadId → 201", offerRes.status === 201, offerRes);
  const offer = dataOf<{ id: number; number: string; leadId: number | null; clientName: string; clientNip: string; site: string; address: string; salespersonId: number | null }>(offerRes);
  ok("oferta niesie lead_id", offer.leadId === offerLeadId, offer);
  ok("oferta: klient i NIP z kontrahenta szansy", offer.clientName.includes(PREFIX) && offer.clientNip === leadNip, offer);
  ok("oferta: obiekt i adres z szansy", offer.site.includes(PREFIX) && offer.address === "ul. Ofertowa 7, Gliwice", offer);
  ok("oferta: handlowiec z szansy", offer.salespersonId === salesperson.id, offer);

  const offerLog = leadLog(offerLeadId);
  ok(
    "dziennik szansy: wpis o utworzonej ofercie",
    offerLog.some((e) => e.action === "linked" && (e.summary ?? "").includes("Utworzono ofertę")),
    offerLog.map((e) => `${e.action}: ${e.summary}`)
  );

  const offersByLead = await S("GET", `/offers?leadId=${offerLeadId}`);
  const offerRows = dataOf<{ id: number; leadTitle: string | null }[]>(offersByLead);
  ok("GET /offers?leadId → tylko oferty tej szansy", offerRows.length === 1 && offerRows[0].id === offer.id, offerRows);
  ok("lista ofert niesie leadTitle", (offerRows[0]?.leadTitle ?? "").includes(PREFIX), offerRows[0]);

  const offerDetail = await S("GET", `/offers/${offer.id}`);
  const offerHead = dataOf<{ offer: { leadId: number | null; leadTitle: string | null; leadStage: string | null } }>(offerDetail).offer;
  ok(
    "szczegóły oferty niosą tytuł i etap szansy",
    offerHead.leadId === offerLeadId && (offerHead.leadTitle ?? "").includes(PREFIX) && offerHead.leadStage === "oferta",
    offerHead
  );

  /*
   * Akceptacja: oferta z JEDNĄ pozycją ręczną (wysyłka wymaga niepustego
   * dokumentu), ale BEZ pozycji magazynowych — dzięki temu `POST /accept` nie
   * tworzy szkicu WZ i test w ogóle nie dotyka stanów magazynu.
   */
  const sectionRes = await S("POST", `/offers/${offer.id}/sections`, { category: "cctv", title: "Montaż" });
  ok("POST /offers/:id/sections → 201", sectionRes.status === 200 || sectionRes.status === 201, sectionRes);
  const sectionId = dataOf<{ sections: { id: number }[] }>(sectionRes).sections.at(-1)!.id;
  const itemRes = await S("POST", `/offers/${offer.id}/items`, {
    sectionId,
    source: "manual",
    name: `${PREFIX} Robocizna`,
    qty: 1,
    unitPrice: 1000,
  });
  ok("POST /offers/:id/items → 200", itemRes.status === 200 || itemRes.status === 201, itemRes);
  const sendRes = await S("POST", `/offers/${offer.id}/send`);
  ok("POST /offers/:id/send → 200", sendRes.status === 200, sendRes);
  const accepted = await S("POST", `/offers/${offer.id}/accept`, {
    requesterName: "Maria Główna",
    requesterPhone: "601202303",
    requesterEmail: "maria@example.invalid",
  });
  ok("POST /offers/:id/accept → 200", accepted.status === 200, accepted);

  const acceptedLog = leadLog(offerLeadId);
  ok(
    "dziennik szansy: wpis o akceptacji oferty",
    acceptedLog.some((e) => e.action === "linked" && (e.summary ?? "").includes("zaakceptowana")),
    acceptedLog.map((e) => `${e.action}: ${e.summary}`)
  );
  const afterAccept = leadRow(offerLeadId);
  ok("akceptacja NIE zmienia etapu szansy", afterAccept.stage === "oferta", afterAccept);
  ok("akceptacja podpina zlecenie do szansy", afterAccept.orderId !== null, afterAccept);
  ok("akceptacja przesuwa last_activity_at", !!afterAccept.lastActivityAt, afterAccept);
  const acceptedOrder = db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, afterAccept.orderId!))
    .get();
  ok("zlecenie z akceptacji dziedziczy handlowca oferty", acceptedOrder?.salespersonId === salesperson.id, acceptedOrder);
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWszystkie testy przeszły." : `\n${failures} test(ów) nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
