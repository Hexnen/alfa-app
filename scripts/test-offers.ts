/**
 * Test modułu Oferty na prawdziwej bazie (data/alfa.db), przez trasy Hono:
 *   npx tsx scripts/test-offers.ts
 *
 * Sprawdza: numerację OF/RRRR/MM/NNN i wersje „-w2", pakiety parametryczne
 * i sztywne, trzy strumienie pieniędzy z dzierżawą włącznie, zamrożenie
 * wysłanej oferty (409) i wyjście przez nową wersję, warianty i opcje,
 * przeliczanie cen, stany magazynowe na pozycjach, akceptację (zlecenie
 * + szkic WZ w jednej transakcji, bez ruszania stanów) oraz — najważniejsze —
 * że użytkownik bez klucza `technical/oferty-koszty` NIE dostaje pól kosztowych
 * w odpowiedzi API, a nie tylko nie widzi ich w UI.
 *
 * Sprząta po sobie HARD (prefiks __OF_TEST__), także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { and, eq, like, inArray } from "drizzle-orm";
import offers from "../src/routes/offers.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const PREFIX = "__OF_TEST__";

/**
 * Udawany użytkownik — trasy czytają go przez `getUser(c)` (c.get("user")).
 * Bierzemy ISTNIEJĄCE id z bazy, bo `activity_log.user_id` ma klucz obcy do
 * `users` i wpis z wymyślonym id wywaliłby całą transakcję.
 */
const realUserId = db.select({ id: schema.users.id }).from(schema.users).all()[0]?.id ?? null;

function userWith(permissions: Record<string, "view" | "edit">): User {
  return {
    id: realUserId,
    email: "test@example.com",
    displayName: "Test",
    role: "user",
    permissions: JSON.stringify(permissions),
  } as unknown as User;
}

const FULL = userWith({ "technical/oferty": "edit", "technical/oferty-koszty": "edit" });
const NO_COSTS = userWith({ "technical/oferty": "edit" });

/** Aplikacja testowa z wstrzykniętym użytkownikiem (middleware auth omijamy). */
function appAs(user: User) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/offers", offers);
  return a;
}

const app = appAs(FULL);
const appNoCosts = appAs(NO_COSTS);

type Res = { status: number; success?: boolean; data?: any; error?: string; message?: string };
async function callOn(a: Hono, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await a.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}
const call = (method: string, path: string, body?: unknown) => callOn(app, method, path, body);

function cleanup() {
  // Oferty: sekcje i pozycje lecą kaskadą, ale kasujemy jawnie — test ma
  // sprzątać nawet wtedy, gdy kaskada akurat jest tym, co się zepsuło.
  const offerRows = db
    .select()
    .from(schema.offers)
    .where(like(schema.offers.number, "OF/%"))
    .all()
    .filter((o) => (o.notes ?? "").includes(PREFIX) || (o.site ?? "").includes(PREFIX));
  const offerIds = offerRows.map((o) => o.id);
  if (offerIds.length) {
    db.delete(schema.offerItems).where(inArray(schema.offerItems.offerId, offerIds)).run();
    db.delete(schema.offerSections).where(inArray(schema.offerSections.offerId, offerIds)).run();
    db.delete(schema.offers).where(inArray(schema.offers.id, offerIds)).run();
  }

  const pkgs = db
    .select()
    .from(schema.offerPackages)
    .where(like(schema.offerPackages.name, `${PREFIX}%`))
    .all();
  if (pkgs.length) {
    const ids = pkgs.map((p) => p.id);
    db.delete(schema.offerPackageItems)
      .where(inArray(schema.offerPackageItems.packageId, ids))
      .run();
    db.delete(schema.offerPackages).where(inArray(schema.offerPackages.id, ids)).run();
  }

  // Zlecenia i dokumenty magazynowe utworzone przez akceptację.
  const docs = db
    .select()
    .from(schema.warehouseDocuments)
    .where(like(schema.warehouseDocuments.notes, "Z oferty OF/%"))
    .all();
  if (docs.length) {
    const ids = docs.map((d) => d.id);
    db.delete(schema.warehouseMovements)
      .where(inArray(schema.warehouseMovements.documentId, ids))
      .run();
    db.delete(schema.warehouseDocumentItems)
      .where(inArray(schema.warehouseDocumentItems.documentId, ids))
      .run();
    db.delete(schema.warehouseDocuments).where(inArray(schema.warehouseDocuments.id, ids)).run();
  }
  db.delete(schema.orders).where(like(schema.orders.notes, "Z oferty OF/%")).run();

  // Towary i usługi testowe.
  const items = db
    .select()
    .from(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .all();
  if (items.length) {
    const ids = items.map((i) => i.id);
    db.delete(schema.warehouseStock).where(inArray(schema.warehouseStock.itemId, ids)).run();
    db.delete(schema.warehouseMovements).where(inArray(schema.warehouseMovements.itemId, ids)).run();
    db.delete(schema.warehouseItems).where(inArray(schema.warehouseItems.id, ids)).run();
  }
  db.delete(schema.services).where(like(schema.services.name, `${PREFIX}%`)).run();
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();

  // Wpisy dziennika po TESTOWYCH ofertach i pakietach — wyłącznie po ich id.
  // Kasowanie całego `entity_type = 'offer'` zabierałoby historię ofert
  // założonych z ekranu przez człowieka, których test nigdy nie widział.
  if (offerIds.length) {
    db.delete(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "offer"),
          inArray(schema.activityLog.entityId, offerIds)
        )
      )
      .run();
  }
  if (pkgs.length) {
    db.delete(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "offer_package"),
          inArray(
            schema.activityLog.entityId,
            pkgs.map((p) => p.id)
          )
        )
      )
      .run();
  }
}

try {
  cleanup();

  // --- Fikstury katalogów ---------------------------------------------------
  const camera = db
    .insert(schema.warehouseItems)
    .values({ name: `${PREFIX} Kamera`, unit: "szt", purchasePrice: 400, salePrice: 500 })
    .returning()
    .get();
  const nvr = db
    .insert(schema.warehouseItems)
    .values({ name: `${PREFIX} Rejestrator 8ch`, unit: "szt", purchasePrice: 800, salePrice: 1000 })
    .returning()
    .get();
  const mount = db
    .insert(schema.services)
    .values({ name: `${PREFIX} Montaż kamery`, unit: "szt", cost: 60, price: 150, category: "montaz" })
    .returning()
    .get();
  const subscription = db
    .insert(schema.services)
    .values({
      name: `${PREFIX} Internet`,
      unit: "mies.",
      cost: 30,
      price: 80,
      category: "abonament",
    })
    .returning()
    .get();
  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX} Klient`, nip: "1111111111", contactPerson: "Jan Kowalski", phone: "600100200", email: "jan@example.com" })
    .returning()
    .get();

  // --- Pakiet parametryczny -------------------------------------------------
  const pkgRes = await call("POST", "/offers/packages", {
    name: `${PREFIX} CCTV Dahua`,
    category: "cctv",
    manufacturer: "Dahua",
    mode: "parametric",
    params: [{ key: "cameras", label: "Liczba kamer", default: 4, min: 1, max: 64 }],
    items: [
      { source: "warehouse", warehouseItemId: camera.id, qtyPerParam: 1, paramKey: "cameras" },
      {
        source: "warehouse",
        warehouseItemId: nvr.id,
        qtyPerParam: 0.125,
        paramKey: "cameras",
        qtyRound: "up",
      },
      {
        source: "service",
        serviceId: mount.id,
        kind: "labour",
        qtyPerParam: 1,
        paramKey: "cameras",
      },
    ],
  });
  ok("pakiet utworzony", pkgRes.status === 201, pkgRes);
  const pkgId: number = pkgRes.data.id;

  const pkgList = await call("GET", "/offers/packages?category=cctv");
  ok(
    "pakiet na liście z licznikiem pozycji",
    (pkgList.data as any[]).find((p) => p.id === pkgId)?.itemCount === 3,
    pkgList.data
  );

  const badPkg = await call("POST", "/offers/packages", { name: `${PREFIX} Zły`, items: [{ source: "warehouse" }] });
  ok("pakiet z pozycją bez towaru odrzucony", badPkg.status === 400, badPkg);

  // --- Oferta ---------------------------------------------------------------
  const created = await call("POST", "/offers", {
    date: "2026-08-10",
    kind: "montaz",
    contractorId: contractor.id,
    clientName: `${PREFIX} Klient`,
    clientNip: "1111111111",
    site: `${PREFIX} Obiekt`,
    address: "ul. Testowa 1",
    notes: PREFIX,
  });
  ok("oferta utworzona", created.status === 201, created);
  ok(
    "numer w formacie OF/RRRR/MM/NNN",
    /^OF\/2026\/08\/\d{3}$/.test(created.data?.number ?? ""),
    created.data?.number
  );
  const offerId: number = created.data.id;
  const offerNumber: string = created.data.number;

  const second = await call("POST", "/offers", { date: "2026-08-10", site: `${PREFIX} Drugi`, notes: PREFIX });
  ok(
    "druga oferta dostaje kolejny numer",
    second.data?.number !== offerNumber &&
      Number(second.data.number.slice(-3)) === Number(offerNumber.slice(-3)) + 1,
    { first: offerNumber, second: second.data?.number }
  );

  const badDates = await call("POST", "/offers", {
    date: "2026-08-10",
    validUntil: "2026-08-01",
    notes: PREFIX,
  });
  ok("termin ważności przed datą oferty odrzucony", badDates.status === 400, badDates);

  // --- Sekcja z pakietu -----------------------------------------------------
  const sect = await call("POST", `/offers/${offerId}/sections`, {
    packageId: pkgId,
    params: { cameras: 8 },
  });
  ok("sekcja z pakietu dodana", sect.status === 201, sect.error);
  const detail = sect.data;
  ok("pakiet rozwinął się na 3 pozycje", detail.items.length === 3, detail.items?.length);
  ok(
    "8 kamer, 1 rejestrator, 8 montaży",
    detail.items[0].qty === 8 && detail.items[1].qty === 1 && detail.items[2].qty === 8,
    detail.items.map((i: any) => `${i.name}=${i.qty}`)
  );
  ok("tytuł sekcji z nazwy pakietu", detail.sections[0].title === `${PREFIX} CCTV Dahua`, detail.sections[0]);
  ok(
    "jednorazowo = 8×500 + 1000 + 8×150 = 6200",
    detail.totals.oneTimePrice === 6200,
    detail.totals
  );
  ok("koszt jednorazowy = 8×400 + 800 + 8×60 = 4480", detail.totals.oneTimeCost === 4480, detail.totals);
  ok(
    "stan magazynowy dopisany do pozycji towarowej",
    detail.items[0].stock === 0,
    detail.items[0]
  );
  ok(
    "pozycja usługowa nie ma stanu magazynowego",
    detail.items[2].stock === null,
    detail.items[2]
  );

  // --- Abonament ------------------------------------------------------------
  const abo = await call("POST", `/offers/${offerId}/sections`, {
    category: "abonament",
    title: "Abonament",
  });
  const aboSectionId = abo.data.sections.find((s: any) => s.title === "Abonament").id;
  const withAbo = await call("POST", `/offers/${offerId}/items`, {
    sectionId: aboSectionId,
    source: "service",
    serviceId: subscription.id,
    kind: "subscription",
    billing: "monthly",
    qty: 1,
  });
  ok("pozycja abonamentowa dodana", withAbo.status === 201, withAbo.error);
  ok("abonament 80 zł/mies.", withAbo.data.totals.monthlyPrice === 80, withAbo.data.totals);
  ok("koszt abonamentu 30 zł", withAbo.data.totals.monthlyCost === 30, withAbo.data.totals);

  // --- Dzierżawa ------------------------------------------------------------
  const leased = await call("PUT", `/offers/${offerId}`, {
    date: "2026-08-10",
    contractorId: contractor.id,
    clientName: `${PREFIX} Klient`,
    site: `${PREFIX} Obiekt`,
    notes: PREFIX,
    leaseMode: "y2",
    leaseAnnualRate: 24,
  });
  ok("dzierżawa zapisana", leased.status === 200, leased.error);
  ok("podstawa = sam sprzęt (5000)", leased.data.totals.leaseBase === 5000, leased.data.totals);
  ok("rata = 100 zł/mies.", leased.data.totals.leaseMonthly === 100, leased.data.totals);
  ok(
    "sprzęt wypada z kwoty jednorazowej — zostaje robocizna 1200",
    leased.data.totals.oneTimePayable === 1200,
    leased.data.totals
  );
  ok("razem miesięcznie = 100 + 80", leased.data.totals.monthlyTotal === 180, leased.data.totals);
  ok("okres dzierżawy wyliczony z trybu", leased.data.offer.leaseMonthsEffective === 24, leased.data.offer);

  const badCustom = await call("PUT", `/offers/${offerId}`, {
    date: "2026-08-10",
    notes: PREFIX,
    leaseMode: "custom",
  });
  ok("dzierżawa „własny okres” bez liczby miesięcy odrzucona", badCustom.status === 400, badCustom);

  // --- Ukrywanie kosztów ----------------------------------------------------
  const asFull = await call("GET", `/offers/${offerId}`);
  ok("z kluczem kosztowym widać koszt pozycji", asFull.data.items[0].unitCost === 400, asFull.data.items[0]);
  ok("…i marżę oferty", asFull.data.totals.margin !== null, asFull.data.totals);

  const asLimited = await callOn(appNoCosts, "GET", `/offers/${offerId}`);
  const rawLimited = JSON.stringify(asLimited.data);
  ok("bez klucza kosztowego pozycja nie ma unitCost", asLimited.data.items[0].unitCost === undefined, asLimited.data.items[0]);
  ok("…ani lineCost", asLimited.data.items[0].lineCost === undefined, asLimited.data.items[0]);
  ok("…ani marży w sumach", asLimited.data.totals.margin === undefined, asLimited.data.totals);
  ok("…ani oneTimeCost / monthlyCost", asLimited.data.totals.oneTimeCost === undefined, asLimited.data.totals);
  // Sprawdzamy KONKRETNE nazwy pól, a nie podciąg „margin" — `marginHorizonMonths`
  // to okres, nie kwota, i ma zostać (podpisuje, czego dotyczy procent).
  for (const f of ["unitCost", "lineCost", "oneTimeCost", "monthlyCost", "horizonCost", "\"margin\"", "belowMinMargin"]) {
    ok(`w JSON-ie nie ma pola ${f}`, !rawLimited.includes(f), rawLimited.slice(0, 200));
  }
  ok(
    "…ale horyzont marży zostaje (to nie kwota)",
    asLimited.data.totals.marginHorizonMonths !== undefined,
    asLimited.data.totals
  );
  ok("…ale ceny sprzedaży zostają", asLimited.data.items[0].unitPrice === 500, asLimited.data.items[0]);
  ok("…i lista też jest przycięta", (await callOn(appNoCosts, "GET", "/offers")).data.every((o: any) => o.totals.margin === undefined));

  // --- Warianty i opcje -----------------------------------------------------
  const varA = await call("POST", `/offers/${offerId}/sections`, {
    title: "Wariant Dahua",
    variantGroup: "rejestrator",
    variantSelected: true,
  });
  const varAId = varA.data.sections.find((s: any) => s.title === "Wariant Dahua").id;
  const varB = await call("POST", `/offers/${offerId}/sections`, {
    title: "Wariant Hikvision",
    variantGroup: "rejestrator",
    variantSelected: true,
  });
  const varBId = varB.data.sections.find((s: any) => s.title === "Wariant Hikvision").id;

  await call("POST", `/offers/${offerId}/items`, {
    sectionId: varAId,
    source: "manual",
    name: "Rejestrator A",
    qty: 1,
    unitPrice: 1500,
    unitCost: 1000,
  });
  const bothVariants = await call("POST", `/offers/${offerId}/items`, {
    sectionId: varBId,
    source: "manual",
    name: "Rejestrator B",
    qty: 1,
    unitPrice: 2500,
    unitCost: 1800,
  });
  // Druga sekcja zapisana jako wybrana przechodzi przez PUT — dopiero on pilnuje
  // wyłączności w grupie. Sam POST dwóch „wybranych" nie jest jeszcze sprzeczny.
  const exclusive = await call("PUT", `/offers/${offerId}/sections/${varBId}`, {
    variantGroup: "rejestrator",
    variantSelected: true,
  });
  const sectionsAfter = exclusive.data.sections;
  const selectedCount = sectionsAfter.filter(
    (s: any) => s.variantGroup === "rejestrator" && s.variantSelected
  ).length;
  ok("w grupie wariantów wybrana jest dokładnie jedna sekcja", selectedCount === 1, sectionsAfter);
  ok(
    "do sumy wchodzi tylko wybrany wariant (6200 + 2500)",
    exclusive.data.totals.oneTimePrice === 8700,
    exclusive.data.totals
  );

  const optional = await call("PUT", `/offers/${offerId}/sections/${varAId}`, {
    variantGroup: "",
    isOptional: true,
  });
  ok(
    "sekcja opcjonalna liczy się osobno (1500)",
    optional.data.totals.optionsOneTime === 1500,
    optional.data.totals
  );

  // --- Przeliczanie cen -----------------------------------------------------
  db.update(schema.warehouseItems)
    .set({ salePrice: 550 })
    .where(eq(schema.warehouseItems.id, camera.id))
    .run();
  const drifted = await call("GET", `/offers/${offerId}`);
  ok(
    "rozjazd ceny widoczny na pozycji",
    drifted.data.items.find((i: any) => i.warehouseItemId === camera.id)?.priceDrift === 550,
    drifted.data.items[0]
  );
  const repriced = await call("POST", `/offers/${offerId}/reprice`);
  ok("przeliczenie zaktualizowało cenę", repriced.data.items[0].unitPrice === 550, repriced.data.items[0]);
  ok("po przeliczeniu nie ma rozjazdu", repriced.data.items[0].priceDrift === null, repriced.data.items[0]);
  const repricedAgain = await call("POST", `/offers/${offerId}/reprice`);
  ok("drugie przeliczenie nic nie zmienia", repricedAgain.message === "Ceny są aktualne", repricedAgain.message);

  // --- Zapis sekcji jako pakiet --------------------------------------------
  const savedPkg = await call(
    "POST",
    `/offers/${offerId}/sections/${detail.sections[0].id}/save-as-package`,
    { name: `${PREFIX} Zapisany zestaw` }
  );
  ok("sekcja zapisana jako pakiet", savedPkg.status === 201, savedPkg);
  ok("zapisany pakiet jest sztywny", savedPkg.data.mode === "fixed", savedPkg.data);
  const savedDetail = await call("GET", `/offers/packages/${savedPkg.data.id}`);
  ok("pakiet przejął 3 pozycje z ilościami", savedDetail.data.items.length === 3, savedDetail.data.items);
  ok(
    "ilości przepisane jako stałe (8 kamer)",
    savedDetail.data.items[0].qtyBase === 8 && savedDetail.data.items[0].qtyPerParam === 0,
    savedDetail.data.items[0]
  );

  // --- Zamrożenie i wersje --------------------------------------------------
  const sent = await call("POST", `/offers/${offerId}/send`);
  ok("oferta wysłana", sent.status === 200 && sent.data.offer.status === "sent", sent.error);

  const blocked = await call("PUT", `/offers/${offerId}`, { date: "2026-08-11", notes: PREFIX });
  ok("edycja wysłanej oferty → 409", blocked.status === 409, blocked);
  const blockedItem = await call("POST", `/offers/${offerId}/items`, {
    sectionId: aboSectionId,
    source: "manual",
    name: "Nie wolno",
    unitPrice: 1,
  });
  ok("dodanie pozycji do wysłanej oferty → 409", blockedItem.status === 409, blockedItem);

  const emptySend = await call("POST", `/offers/${second.data.id}/send`);
  ok("pustej oferty nie da się wysłać", emptySend.status === 400, emptySend);

  const v2 = await call("POST", `/offers/${offerId}/version`);
  ok("nowa wersja utworzona", v2.status === 201, v2);
  ok("numer wersji z sufiksem -w2", v2.data.number === `${offerNumber}-w2`, v2.data.number);
  ok("wersja wraca do szkicu", v2.data.status === "draft", v2.data);
  const v2Detail = await call("GET", `/offers/${v2.data.id}`);
  ok(
    "wersja skopiowała sekcje i pozycje",
    v2Detail.data.items.length === repriced.data.items.length,
    { v2: v2Detail.data.items.length, v1: repriced.data.items.length }
  );
  ok("wersja ma te same sumy co oryginał", v2Detail.data.totals.oneTimePrice === repriced.data.totals.oneTimePrice, {
    v2: v2Detail.data.totals.oneTimePrice,
    v1: repriced.data.totals.oneTimePrice,
  });
  const v3 = await call("POST", `/offers/${v2.data.id}/version`);
  ok("trzecia wersja liczy się od korzenia, nie od kopii", v3.data.number === `${offerNumber}-w3`, v3.data.number);

  // Numeracja miesiąca nie łapie się na sufiksy wersji.
  const afterVersions = await call("POST", "/offers", { date: "2026-08-10", site: `${PREFIX} Trzeci`, notes: PREFIX });
  ok(
    "wersje nie zjadają numerów w miesiącu",
    Number(afterVersions.data.number.slice(-3)) === Number(offerNumber.slice(-3)) + 2,
    { base: offerNumber, next: afterVersions.data.number }
  );

  // --- Akceptacja: zlecenie + szkic WZ -------------------------------------
  const stockBefore = db
    .select()
    .from(schema.warehouseStock)
    .where(eq(schema.warehouseStock.itemId, camera.id))
    .all();

  // Kwoty do porównania bierzemy z samej oferty, a nie wpisujemy na sztywno:
  // po przeliczeniu cen i dodaniu wariantu stała liczba i tak by się rozjechała,
  // a sprawdzamy tu PRZEPISANIE kwot do zlecenia, nie arytmetykę (od tego jest
  // scripts/test-offer-calc.ts).
  const beforeAccept = await call("GET", `/offers/${offerId}`);
  const expectedMonthly = beforeAccept.data.totals.monthlyPrice;
  const expectedLease = beforeAccept.data.totals.leaseMonthly;

  const accepted = await call("POST", `/offers/${offerId}/accept`);
  ok("akceptacja przeszła", accepted.status === 200, accepted.error);
  ok("powstało zlecenie", !!accepted.data.created.orderNumber, accepted.data.created);
  ok("powstał szkic WZ", accepted.data.created.warehouseDocId !== null, accepted.data.created);

  const order = db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, accepted.data.created.orderId))
    .all()[0];
  ok(
    `zlecenie ma abonament z oferty (${expectedMonthly})`,
    order?.monthlyAmount === expectedMonthly,
    { got: order?.monthlyAmount, expected: expectedMonthly }
  );
  ok(
    `zlecenie ma ratę dzierżawy (${expectedLease})`,
    order?.rentalAmount === expectedLease,
    { got: order?.rentalAmount, expected: expectedLease }
  );
  ok("zlecenie ma okres dzierżawy 24 mies.", order?.rentalLengthMonths === 24, order);
  ok("zlecenie wskazuje kontrahenta z oferty", order?.payerContractorId === contractor.id, order);

  const wz = db
    .select()
    .from(schema.warehouseDocuments)
    .where(eq(schema.warehouseDocuments.id, accepted.data.created.warehouseDocId))
    .all()[0];
  ok("WZ jest szkicem, nie zatwierdzonym", wz?.status === "draft", wz);
  ok("WZ nie ma jeszcze numeru", wz?.docNumber === null, wz);
  const wzItems = db
    .select()
    .from(schema.warehouseDocumentItems)
    .where(eq(schema.warehouseDocumentItems.documentId, wz.id))
    .all();
  ok(
    "WZ ma tylko sprzęt (kamera + rejestrator), bez robocizny i abonamentu",
    wzItems.length === 2,
    wzItems
  );

  const stockAfter = db
    .select()
    .from(schema.warehouseStock)
    .where(eq(schema.warehouseStock.itemId, camera.id))
    .all();
  ok(
    "szkic WZ NIE rusza stanów magazynowych",
    JSON.stringify(stockBefore) === JSON.stringify(stockAfter),
    { stockBefore, stockAfter }
  );

  const acceptTwice = await call("POST", `/offers/${offerId}/accept`);
  ok("druga akceptacja tej samej oferty → 409", acceptTwice.status === 409, acceptTwice);

  // --- Kaskada usuwania -----------------------------------------------------
  const toDelete = v3.data.id;
  const before = db
    .select()
    .from(schema.offerItems)
    .where(eq(schema.offerItems.offerId, toDelete))
    .all().length;
  ok("wersja do skasowania ma pozycje", before > 0, before);
  const del = await call("DELETE", `/offers/${toDelete}`);
  ok("oferta usunięta", del.status === 200, del);
  const leftItems = db
    .select()
    .from(schema.offerItems)
    .where(eq(schema.offerItems.offerId, toDelete))
    .all();
  const leftSections = db
    .select()
    .from(schema.offerSections)
    .where(eq(schema.offerSections.offerId, toDelete))
    .all();
  ok("pozycje poleciały kaskadą", leftItems.length === 0, leftItems);
  ok("sekcje poleciały kaskadą", leftSections.length === 0, leftSections);

  const missing = await call("GET", "/offers/99999999");
  ok("nieistniejąca oferta → 404", missing.status === 404, missing);

  // ===================================================================
  // REGRESJE Z BUGHUNTU (2026-08-31)
  // ===================================================================

  // --- Kasowanie podlega zamrożeniu ---
  const r1 = await call("POST", "/offers", { date: "2026-08-10", site: PREFIX, notes: PREFIX });
  const r1id = r1.data.id;
  const r1s = await call("POST", `/offers/${r1id}/sections`, { title: "S" });
  await call("POST", `/offers/${r1id}/items`, {
    sectionId: r1s.data.sections[0].id, source: "manual", name: "X", qty: 1, unitPrice: 100,
  });
  await call("POST", `/offers/${r1id}/send`);
  const delSent = await call("DELETE", `/offers/${r1id}`);
  ok("kasowanie WYSŁANEJ oferty → 409", delSent.status === 409, delSent);

  // --- accept tylko z „wysłana" ---
  await call("POST", `/offers/${r1id}/reject`);
  const acceptRejected = await call("POST", `/offers/${r1id}/accept`);
  ok("akceptacja ODRZUCONEJ oferty → 409", acceptRejected.status === 409, acceptRejected);
  const rejectTwice = await call("POST", `/offers/${r1id}/reject`);
  ok("powtórne odrzucenie → 409", rejectTwice.status === 409, rejectTwice);

  // --- reject nie działa na szkicu ---
  const r2 = await call("POST", "/offers", { date: "2026-08-10", site: PREFIX, notes: PREFIX });
  const rejectDraft = await call("POST", `/offers/${r2.data.id}/reject`);
  ok("odrzucenie SZKICU → 409", rejectDraft.status === 409, rejectDraft);

  // --- PUT częściowy nie kasuje reszty nagłówka ---
  const full = await call("PUT", `/offers/${r2.data.id}`, {
    date: "2026-08-10", site: PREFIX, notes: PREFIX, clientName: "Klient X", clientNip: "1234567890",
    discountPct: 10, leaseMode: "y2", leaseAnnualRate: 24,
  });
  ok("pełny zapis nagłówka", full.status === 200, full.error);
  const partial = await call("PUT", `/offers/${r2.data.id}`, { site: "Nowa nazwa" });
  const after = partial.data.offer;
  ok("częściowy PUT zmienia wskazane pole", after.site === "Nowa nazwa", after);
  ok("…i NIE kasuje klienta", after.clientName === "Klient X", after);
  ok("…ani NIP-u", after.clientNip === "1234567890", after);
  ok("…ani rabatu", after.discountPct === 10, after);
  ok("…ani dzierżawy", after.leaseMode === "y2" && after.leaseAnnualRate === 24, after);
  ok("…ani daty (numer zostaje w swoim miesiącu)", after.date === "2026-08-10", after);

  // --- Warianty: dwie sekcje w grupie nie mogą być obie wybrane ---
  const vA = await call("POST", `/offers/${r2.data.id}/sections`, {
    title: "Wariant A", variantGroup: "rej", variantSelected: true,
  });
  const vB = await call("POST", `/offers/${r2.data.id}/sections`, {
    title: "Wariant B", variantGroup: "rej", variantSelected: true,
  });
  const grupa = vB.data.sections.filter((s: any) => s.variantGroup === "rej");
  ok(
    "POST dwóch wariantów: wybrany dokładnie jeden",
    grupa.filter((s: any) => s.variantSelected).length === 1,
    grupa
  );

  // --- Nie da się odznaczyć ostatniego wybranego wariantu ---
  const selected = grupa.find((s: any) => s.variantSelected);
  const unselectLast = await call("PUT", `/offers/${r2.data.id}/sections/${selected.id}`, {
    variantSelected: false,
  });
  ok("odznaczenie jedynego wybranego wariantu → 400", unselectLast.status === 400, unselectLast);

  // --- Wyjście z grupy włącza sekcję do sum, nie zostawia jej „niewybranej" ---
  const notSelected = grupa.find((s: any) => !s.variantSelected);
  const leave = await call("PUT", `/offers/${r2.data.id}/sections/${notSelected.id}`, {
    variantGroup: "",
  });
  const left = leave.data.sections.find((s: any) => s.id === notSelected.id);
  ok("po wyjściu z grupy sekcja jest wybrana", left.variantSelected === true, left);
  ok("…i nie ma już grupy", left.variantGroup === null, left);

  void vA;

  // --- Faktyczny zakres oferty na liście ---
  {
    const listed = (await call("GET", "/offers")).data as any[];
    const withPkg = listed.find((o: any) => o.id === offerId);
    ok(
      "zakres zawiera CCTV z sekcji pakietowej",
      withPkg.scope.includes("cctv"),
      withPkg.scope
    );
    ok(
      "…abonament z POZYCJI miesięcznej, nie z kategorii sekcji",
      withPkg.scope.includes("abonament"),
      withPkg.scope
    );
    ok("…i dzierżawę, bo jest aktywna", withPkg.scope.includes("dzierzawa"), withPkg.scope);
    ok(
      "dzierżawa jest na końcu (sposób rozliczenia, nie system)",
      withPkg.scope[withPkg.scope.length - 1] === "dzierzawa",
      withPkg.scope
    );

    // Pusta sekcja to zakładka bez treści — nie zakres.
    const empty = await call("POST", "/offers", { date: "2026-08-10", site: PREFIX, notes: PREFIX });
    await call("POST", `/offers/${empty.data.id}/sections`, { category: "sswin", title: "Pusta" });
    const afterEmpty = ((await call("GET", "/offers")).data as any[]).find(
      (o: any) => o.id === empty.data.id
    );
    ok("pusta sekcja nie trafia do zakresu", afterEmpty.scope.length === 0, afterEmpty.scope);
  }

  // --- Domyślny procent dzierżawy (117% rocznie) ---
  const cfgRes = await call("GET", "/offers/config");
  ok("konfiguracja ofert dostępna pod kluczem ofert", cfgRes.status === 200, cfgRes);
  const defaultRate = cfgRes.data.leaseAnnualRate;
  ok("domyślny procent dzierżawy = 117", defaultRate === 117, cfgRes.data);

  const r3 = await call("POST", "/offers", { date: "2026-08-10", site: PREFIX, notes: PREFIX });
  const r3s = await call("POST", `/offers/${r3.data.id}/sections`, { title: "Sprzęt" });
  await call("POST", `/offers/${r3.data.id}/items`, {
    sectionId: r3s.data.sections[0].id, source: "manual", name: "Kamera", qty: 10,
    unitPrice: 500, unitCost: 400, kind: "material",
  });
  // Włączenie dzierżawy BEZ podania stawki ma wziąć domyślną, a nie zostawić 0.
  const leaseOn = await call("PUT", `/offers/${r3.data.id}`, { leaseMode: "y2" });
  ok("włączenie dzierżawy bez stawki bierze domyślne 117%", leaseOn.data.offer.leaseAnnualRate === 117, leaseOn.data.offer);
  // 5000 zł sprzętu × 117% / 12 = 487,50 zł/mies.
  ok("rata liczona z domyślnej stawki = 487,50", leaseOn.data.totals.leaseMonthly === 487.5, leaseOn.data.totals);
  // Jawnie podana stawka nadal wygrywa.
  const custom = await call("PUT", `/offers/${r3.data.id}`, { leaseAnnualRate: 60 });
  ok("własna stawka nadpisuje domyślną", custom.data.offer.leaseAnnualRate === 60, custom.data.offer);
  ok("…i rata idzie za nią (250)", custom.data.totals.leaseMonthly === 250, custom.data.totals);
} finally {
  cleanup();

  const leftOffers = db
    .select()
    .from(schema.offers)
    .all()
    .filter((o) => (o.notes ?? "").includes(PREFIX) || (o.site ?? "").includes(PREFIX));
  ok("sprzątanie: brak testowych ofert", leftOffers.length === 0, leftOffers.map((o) => o.number));
  const leftPkgs = db
    .select()
    .from(schema.offerPackages)
    .where(like(schema.offerPackages.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych pakietów", leftPkgs.length === 0, leftPkgs);
  const leftOrders = db
    .select()
    .from(schema.orders)
    .where(like(schema.orders.notes, "Z oferty OF/%"))
    .all();
  ok("sprzątanie: brak testowych zleceń", leftOrders.length === 0, leftOrders);
  const leftDocs = db
    .select()
    .from(schema.warehouseDocuments)
    .where(like(schema.warehouseDocuments.notes, "Z oferty OF/%"))
    .all();
  ok("sprzątanie: brak testowych dokumentów WZ", leftDocs.length === 0, leftDocs);
  const leftItems = db
    .select()
    .from(schema.warehouseItems)
    .where(like(schema.warehouseItems.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych towarów", leftItems.length === 0, leftItems);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
