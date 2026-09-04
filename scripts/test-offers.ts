/**
 * Test modułu Oferty na prawdziwej bazie (data/alfa.db), przez trasy Hono:
 *   npx tsx scripts/test-offers.ts
 *
 * Sprawdza: numerację OF/RRRR/MM/NNN i wersje „-w2", pakiety parametryczne
 * i sztywne, trzy strumienie pieniędzy z dzierżawą włącznie, zamrożenie
 * wysłanej oferty (409) i wyjście przez nową wersję, warianty i opcje,
 * przeliczanie cen, stany magazynowe na pozycjach, bibliotekę OPISÓW (blok na
 * ofercie jest KOPIĄ wzorca, nie odwołaniem do niego), akceptację (zlecenie
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
    db.delete(schema.offerTextBlocks)
      .where(inArray(schema.offerTextBlocks.offerId, offerIds))
      .run();
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

  // Katalog opisów. Bloki na ofertach wskazują na wzorce przez `set null`,
  // ale testowe oferty i tak poleciały wyżej — zostaje sam katalog.
  const texts = db
    .select()
    .from(schema.offerTexts)
    .where(like(schema.offerTexts.name, `${PREFIX}%`))
    .all();
  if (texts.length) {
    const ids = texts.map((t) => t.id);
    db.delete(schema.offerTexts).where(inArray(schema.offerTexts.id, ids)).run();
    db.delete(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "offer_text"),
          inArray(schema.activityLog.entityId, ids)
        )
      )
      .run();
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
  // Stemple wieku ceny wpisane wprost: pozycja oferty ma je oddawać z kartoteki,
  // a fikstura zakładana przez `db.insert` omija trasy, które je nadają.
  const CAMERA_PRICE_STAMP = "2026-01-15 10:00:00";
  const MOUNT_PRICE_STAMP = "2025-11-02 08:30:00";
  const camera = db
    .insert(schema.warehouseItems)
    .values({
      name: `${PREFIX} Kamera`,
      unit: "szt",
      purchasePrice: 400,
      salePrice: 500,
      priceUpdatedAt: CAMERA_PRICE_STAMP,
    })
    .returning()
    .get();
  const nvr = db
    .insert(schema.warehouseItems)
    .values({ name: `${PREFIX} Rejestrator 8ch`, unit: "szt", purchasePrice: 800, salePrice: 1000 })
    .returning()
    .get();
  const mount = db
    .insert(schema.services)
    .values({
      name: `${PREFIX} Montaż kamery`,
      unit: "szt",
      cost: 60,
      price: 150,
      category: "montaz",
      priceUpdatedAt: MOUNT_PRICE_STAMP,
    })
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
  // Wiek ceny z kartoteki — sygnał niezależny od `priceDrift`: cena może się
  // zgadzać z migawką i mimo to pochodzić ze starego cennika.
  ok(
    "pozycja towarowa niesie wiek ceny z kartoteki",
    detail.items[0].priceUpdatedAt === CAMERA_PRICE_STAMP,
    detail.items[0]
  );
  ok(
    "pozycja usługowa niesie wiek ceny z katalogu usług",
    detail.items[2].priceUpdatedAt === MOUNT_PRICE_STAMP,
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
  // Druga kartoteka też drgnęła — dopiero wtedy widać, że aktualizacja
  // pojedynczej pozycji NIE rusza sąsiadów.
  db.update(schema.services).set({ price: 170 }).where(eq(schema.services.id, mount.id)).run();
  const preview = await call("GET", `/offers/${offerId}/reprice-preview`);
  const previewed = preview.data.find((ch: any) => ch.name === camera.name);
  ok("podgląd wymienia pozycję z ceną przed i po", previewed?.oldUnitPrice === 500 && previewed?.newUnitPrice === 550, preview.data);
  ok("podgląd widzi obie zmienione kartoteki", preview.data.length === 2, preview.data);
  ok("podgląd nic nie zapisuje", (await call("GET", `/offers/${offerId}`)).data.items[0].unitPrice === 500, "cena zmieniona przed zatwierdzeniem");

  // --- Aktualizacja POJEDYNCZEJ pozycji ------------------------------------
  const one = await call("POST", `/offers/${offerId}/reprice`, { itemIds: [previewed.itemId] });
  ok("pojedyncza aktualizacja rusza wskazaną pozycję", one.data.items.find((i: any) => i.id === previewed.itemId)?.unitPrice === 550, one.data.items);
  ok(
    "…i nie rusza pozostałych",
    one.data.items.filter((i: any) => i.serviceId === mount.id).every((i: any) => i.unitPrice === 150),
    one.data.items.filter((i: any) => i.serviceId === mount.id)
  );
  ok("…a komunikat mówi o jednej pozycji", one.message === "Zaktualizowano ceny w 1 pozycji", one.message);
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

  // --- Adres oferty z numeru (deep link) ------------------------------------
  const slug = offerNumber.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byNumber = await call("GET", `/offers/number/${slug}`);
  ok("oferta spod adresu z numeru", byNumber.data?.offer?.id === offerId, byNumber.error);
  const byNumberDashes = await call("GET", `/offers/number/${offerNumber.replace(/\//g, "-")}`);
  ok(
    "myślniki w adresie też trafiają w numer",
    byNumberDashes.data?.offer?.id === offerId,
    byNumberDashes.error
  );
  const badSlug = await call("GET", "/offers/number/of000000999");
  ok("nieznany adres → 404", badSlug.status === 404, badSlug);

  // --- Sloty wariantów i przeliczanie sekcji ---------------------------------
  // Slot to jedno miejsce w zestawie, w którym pakiet WYBIERA sprzęt zależnie od
  // parametru: 1–8 kamer → rejestrator 8ch, 9–16 → 16ch, 17+ → 32ch.
  const nvr16 = db
    .insert(schema.warehouseItems)
    .values({ name: `${PREFIX} Rejestrator 16ch`, unit: "szt", purchasePrice: 1600, salePrice: 2000 })
    .returning()
    .get();
  const nvr32 = db
    .insert(schema.warehouseItems)
    .values({ name: `${PREFIX} Rejestrator 32ch`, unit: "szt", purchasePrice: 3200, salePrice: 4000 })
    .returning()
    .get();

  const slotVariants = (min: number | null, max: number | null, itemId: number) => ({
    source: "warehouse",
    warehouseItemId: itemId,
    qtyBase: 1,
    paramKey: "cameras",
    slot: "Rejestrator",
    paramMin: min,
    paramMax: max,
  });
  const slotPkgRes = await call("POST", "/offers/packages", {
    name: `${PREFIX} CCTV sloty`,
    category: "cctv",
    mode: "parametric",
    params: [{ key: "cameras", label: "Liczba kamer", default: 8, min: 1, max: 64 }],
    items: [
      { source: "warehouse", warehouseItemId: camera.id, qtyPerParam: 1, paramKey: "cameras" },
      slotVariants(null, 8, nvr.id),
      slotVariants(9, 16, nvr16.id),
      slotVariants(17, null, nvr32.id),
    ],
  });
  ok("pakiet ze slotem utworzony", slotPkgRes.status === 201, slotPkgRes);
  const slotPkgId: number = slotPkgRes.data.id;

  const overlapping = await call("POST", "/offers/packages", {
    name: `${PREFIX} Nachodzące`,
    mode: "parametric",
    params: [{ key: "cameras", label: "Kamery", default: 8, min: 1 }],
    items: [slotVariants(null, 10, nvr.id), slotVariants(9, 16, nvr16.id)],
  });
  ok("nachodzące zakresy w slocie odrzucone", overlapping.status === 400, overlapping);

  const rangeNoSlot = await call("POST", "/offers/packages", {
    name: `${PREFIX} Zakres bez slotu`,
    mode: "parametric",
    params: [{ key: "cameras", label: "Kamery", default: 8, min: 1 }],
    items: [{ source: "warehouse", warehouseItemId: camera.id, qtyBase: 1, paramMin: 5 }],
  });
  ok("zakres bez slotu odrzucony", rangeNoSlot.status === 400, rangeNoSlot);

  const slotOffer = await call("POST", "/offers", {
    date: "2026-08-10",
    contractorId: contractor.id,
    site: `${PREFIX} Sloty`,
    notes: PREFIX,
  });
  const slotOfferId: number = slotOffer.data.id;

  const slotSect = await call("POST", `/offers/${slotOfferId}/sections`, {
    packageId: slotPkgId,
    params: { cameras: 12 },
  });
  ok("sekcja ze slotem dodana", slotSect.status === 201, slotSect.error);
  const slotSectionId: number = slotSect.data.sections[0].id;
  ok(
    "12 kamer → jeden rejestrator, 16-kanałowy",
    slotSect.data.items.length === 2 &&
      slotSect.data.items[1].name === `${PREFIX} Rejestrator 16ch` &&
      slotSect.data.items[1].qty === 1,
    slotSect.data.items.map((i: any) => `${i.name}=${i.qty}`)
  );

  const reexpanded = await call("POST", `/offers/${slotOfferId}/sections/${slotSectionId}/reexpand`, {
    params: { cameras: 30 },
  });
  ok("sekcja przeliczona", reexpanded.status === 200, reexpanded.error);
  ok(
    "30 kamer → rejestrator 32-kanałowy zamiast 16",
    reexpanded.data.items.length === 2 &&
      reexpanded.data.items[0].qty === 30 &&
      reexpanded.data.items[1].name === `${PREFIX} Rejestrator 32ch`,
    reexpanded.data.items.map((i: any) => `${i.name}=${i.qty}`)
  );
  ok(
    "nowa wartość parametru zapisana na sekcji",
    JSON.parse(reexpanded.data.sections[0].params).cameras === 30,
    reexpanded.data.sections[0].params
  );

  const emptySection = await call("POST", `/offers/${slotOfferId}/sections`, {
    category: "inne",
    title: `${PREFIX} Ręczna`,
  });
  const emptySectionId: number =
    emptySection.data.sections.find((x: any) => x.id !== slotSectionId).id;
  const reexpandManual = await call(
    "POST",
    `/offers/${slotOfferId}/sections/${emptySectionId}/reexpand`,
    { params: { cameras: 10 } }
  );
  ok("przeliczenie sekcji spoza pakietu → 400", reexpandManual.status === 400, reexpandManual);

  await call("POST", `/offers/${slotOfferId}/send`);
  const reexpandSent = await call("POST", `/offers/${slotOfferId}/sections/${slotSectionId}/reexpand`, {
    params: { cameras: 8 },
  });
  ok("przeliczenie sekcji w wysłanej ofercie → 409", reexpandSent.status === 409, reexpandSent);

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

  // ===================================================================
  // OPISY — biblioteka wzorców i bloki na ofercie
  // ===================================================================

  // --- CRUD wzorca ---
  const GWARANCJA = "**24 miesiące** na sprzęt.";
  const tpl = await call("POST", "/offers/texts", {
    name: `${PREFIX} Gwarancja`,
    category: "cctv",
    title: "Gwarancja",
    body: GWARANCJA,
  });
  ok("wzorzec opisu utworzony", tpl.status === 201, tpl);
  const tplId: number = tpl.data.id;

  const tplGet = await call("GET", `/offers/texts/${tplId}`);
  ok("wzorzec czytany po id", tplGet.data?.body === GWARANCJA, tplGet);
  const tplMissing = await call("GET", "/offers/texts/99999999");
  ok("nieistniejący wzorzec → 404", tplMissing.status === 404, tplMissing);
  const tplNoName = await call("POST", "/offers/texts", { body: "bez nazwy" });
  ok("wzorzec bez nazwy → 400", tplNoName.status === 400, tplNoName);

  const tplList = await call("GET", "/offers/texts?category=cctv");
  ok(
    "wzorzec na liście swojej kategorii",
    (tplList.data as any[]).some((t) => t.id === tplId),
    tplList.data
  );

  // --- Wzorzec „domyślny" wjeżdża na każdą nową ofertę ---
  const tplDefault = await call("POST", "/offers/texts", {
    name: `${PREFIX} Warunki płatności`,
    title: "Warunki płatności",
    body: "Przelew 14 dni.",
    isDefault: true,
  });
  ok("wzorzec domyślny utworzony", tplDefault.status === 201, tplDefault);

  const withTexts = await call("POST", "/offers", {
    date: "2026-08-10",
    site: PREFIX,
    notes: PREFIX,
  });
  const wtId: number = withTexts.data.id;
  const wtFresh = await call("GET", `/offers/${wtId}`);
  ok(
    "domyślny opis wjeżdża na świeżą ofertę",
    wtFresh.data.texts.length === 1 && wtFresh.data.texts[0].textId === tplDefault.data.id,
    wtFresh.data.texts
  );

  // --- Dołączenie wzorca KOPIUJE treść ---
  const attached = await call("POST", `/offers/${wtId}/texts`, { textId: tplId });
  ok("opis z wzorca dołączony", attached.status === 201, attached);
  const block = (attached.data.texts as any[]).find((b) => b.textId === tplId);
  ok("nagłówek skopiowany z wzorca", block.title === "Gwarancja", block);
  ok("treść skopiowana z wzorca", block.body === GWARANCJA, block);
  ok("nowy blok ląduje na końcu", block.position === 2, block);

  // Sedno decyzji „kopia, nie referencja": poprawka wzorca nie przepisuje
  // wstecz dokumentu, który już powstał.
  const tplEdited = await call("PUT", `/offers/texts/${tplId}`, {
    name: `${PREFIX} Gwarancja`,
    category: "cctv",
    title: "Gwarancja 36",
    body: "**36 miesięcy** na sprzęt.",
  });
  ok("wzorzec zapisany", tplEdited.status === 200, tplEdited);
  const afterEdit = ((await call("GET", `/offers/${wtId}`)).data.texts as any[]).find(
    (b) => b.id === block.id
  );
  ok("blok na ofercie NIE poszedł za wzorcem", afterEdit.body === GWARANCJA, afterEdit);

  // --- Archiwizacja wzorca zostawia blok nietknięty ---
  const tplArchived = await call("DELETE", `/offers/texts/${tplId}`);
  ok("wzorzec zarchiwizowany", tplArchived.status === 200, tplArchived);
  const tplRow = db
    .select()
    .from(schema.offerTexts)
    .where(eq(schema.offerTexts.id, tplId))
    .all()[0];
  ok("rekord wzorca zostaje w bazie", !!tplRow, tplRow);
  ok("…z active = false", tplRow?.active === false, tplRow);
  const listActive = await call("GET", "/offers/texts");
  ok(
    "zarchiwizowany wzorzec znika z listy",
    !(listActive.data as any[]).some((t) => t.id === tplId),
    listActive.data
  );
  const listAll = await call("GET", "/offers/texts?includeInactive=1");
  ok(
    "…ale wraca przy includeInactive=1",
    (listAll.data as any[]).some((t) => t.id === tplId),
    listAll.data
  );
  const afterArchive = ((await call("GET", `/offers/${wtId}`)).data.texts as any[]).find(
    (b) => b.id === block.id
  );
  ok(
    "blok na ofercie przeżywa archiwizację wzorca",
    afterArchive?.body === GWARANCJA,
    afterArchive
  );

  /*
   * Edytor wzorca nie ma przełącznika archiwum, więc `active` w body nie
   * przychodzi. Gdyby PUT wracał wtedy do wartości fabrycznej, zapis literówki
   * w zarchiwizowanym opisie wskrzeszałby go po cichu w bibliotece.
   */
  const tplReedit = await call("PUT", `/offers/texts/${tplId}`, {
    name: `${PREFIX} Gwarancja`,
    title: "Warunki gwarancji",
    body: `${GWARANCJA} Poprawka.`,
  });
  ok("zarchiwizowany wzorzec da się poprawić", tplReedit.status === 200, tplReedit);
  ok(
    "…i zostaje zarchiwizowany",
    (tplReedit.data as any)?.active === false,
    tplReedit.data
  );

  // --- Blok własny, bez wzorca ---
  const ownRes = await call("POST", `/offers/${wtId}/texts`, {
    title: "Uwagi",
    body: "Tekst własny",
  });
  ok("własny blok dodany bez wzorca", ownRes.status === 201, ownRes);
  const ownBlock = (ownRes.data.texts as any[]).find((b) => b.title === "Uwagi");
  ok("własny blok nie ma śladu wzorca", ownBlock.textId === null, ownBlock);
  const badTpl = await call("POST", `/offers/${wtId}/texts`, { textId: 99999999 });
  ok("dołączenie nieistniejącego wzorca → 404", badTpl.status === 404, badTpl);

  // --- PUT cząstkowy ---
  const patched = await call("PUT", `/offers/${wtId}/texts/${ownBlock.id}`, {
    body: "Tekst poprawiony",
  });
  const patchedBlock = (patched.data.texts as any[]).find((b) => b.id === ownBlock.id);
  ok("PUT zmienia treść bloku", patchedBlock.body === "Tekst poprawiony", patchedBlock);
  ok("…i NIE kasuje nagłówka", patchedBlock.title === "Uwagi", patchedBlock);

  const foreignOffer = await call("POST", "/offers", {
    date: "2026-08-10",
    site: PREFIX,
    notes: PREFIX,
  });
  const foreignPut = await call(
    "PUT",
    `/offers/${foreignOffer.data.id}/texts/${ownBlock.id}`,
    { body: "x" }
  );
  ok("edycja bloku z obcej oferty → 404", foreignPut.status === 404, foreignPut);
  const foreignDelete = await call(
    "DELETE",
    `/offers/${foreignOffer.data.id}/texts/${ownBlock.id}`
  );
  ok("usunięcie bloku z obcej oferty → 404", foreignDelete.status === 404, foreignDelete);

  // --- Usuwanie bloku ---
  const throwaway = await call("POST", `/offers/${wtId}/texts`, { title: "Do skasowania" });
  const throwawayId = (throwaway.data.texts as any[]).find(
    (b) => b.title === "Do skasowania"
  ).id;
  const removed = await call("DELETE", `/offers/${wtId}/texts/${throwawayId}`);
  ok(
    "blok usunięty z oferty",
    removed.status === 200 && !(removed.data.texts as any[]).some((b) => b.id === throwawayId),
    removed.data?.texts
  );

  // --- Kolejność ---
  const beforeOrder = (await call("GET", `/offers/${wtId}`)).data.texts as any[];
  const reversed = [...beforeOrder].map((b) => b.id).reverse();
  const reorder = await call("POST", `/offers/${wtId}/texts/reorder`, { ids: reversed });
  ok("reorder zapisany", reorder.status === 200, reorder);
  ok(
    "kolejność opisów odwrócona",
    (reorder.data.texts as any[]).map((b) => b.id).join(",") === reversed.join(","),
    reorder.data.texts
  );
  const reorderForeign = await call("POST", `/offers/${wtId}/texts/reorder`, {
    ids: [...reversed, 99999999],
  });
  ok("reorder z obcym id → 400", reorderForeign.status === 400, reorderForeign);
  const reorderShort = await call("POST", `/offers/${wtId}/texts/reorder`, {
    ids: [reversed[0]],
  });
  ok("reorder z niepełną listą → 400", reorderShort.status === 400, reorderShort);

  // --- Zamrożenie: po wysyłce bloki są nietykalne ---
  const wtSection = await call("POST", `/offers/${wtId}/sections`, { title: "S" });
  await call("POST", `/offers/${wtId}/items`, {
    sectionId: wtSection.data.sections[0].id,
    source: "manual",
    name: "X",
    qty: 1,
    unitPrice: 100,
  });
  const parentTexts = (await call("GET", `/offers/${wtId}`)).data.texts as any[];
  const wtSent = await call("POST", `/offers/${wtId}/send`);
  ok("oferta z opisami wysłana", wtSent.status === 200, wtSent.error);

  const addFrozen = await call("POST", `/offers/${wtId}/texts`, { title: "Za późno" });
  ok("dodanie opisu do WYSŁANEJ oferty → 409", addFrozen.status === 409, addFrozen);
  const editFrozen = await call("PUT", `/offers/${wtId}/texts/${ownBlock.id}`, { body: "x" });
  ok("edycja opisu na WYSŁANEJ ofercie → 409", editFrozen.status === 409, editFrozen);
  const delFrozen = await call("DELETE", `/offers/${wtId}/texts/${ownBlock.id}`);
  ok("usunięcie opisu z WYSŁANEJ oferty → 409", delFrozen.status === 409, delFrozen);
  const reorderFrozen = await call("POST", `/offers/${wtId}/texts/reorder`, { ids: reversed });
  ok("reorder na WYSŁANEJ ofercie → 409", reorderFrozen.status === 409, reorderFrozen);

  // --- Nowa wersja odtwarza opisy Z RODZICA, nie z katalogu ---
  const wtVersion = await call("POST", `/offers/${wtId}/version`);
  ok("wersja oferty z opisami utworzona", wtVersion.status === 201, wtVersion);
  const versionTexts = (await call("GET", `/offers/${wtVersion.data.id}`)).data.texts as any[];
  ok(
    "wersja przenosi komplet opisów rodzica",
    versionTexts.length === parentTexts.length &&
      versionTexts.map((b) => b.body).join("|") === parentTexts.map((b) => b.body).join("|"),
    versionTexts
  );
  ok(
    "…jako nowe rekordy, nie te same wiersze",
    versionTexts.every((b) => !parentTexts.some((pb) => pb.id === b.id)),
    versionTexts.map((b) => b.id)
  );
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
  const leftTexts = db
    .select()
    .from(schema.offerTexts)
    .where(like(schema.offerTexts.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych opisów", leftTexts.length === 0, leftTexts);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
