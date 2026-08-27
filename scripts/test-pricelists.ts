/**
 * Test wielu cenników (price_lists + price_list.price_list_id) na prawdziwej bazie
 * (data/alfa.db), przez trasy Hono (app.request):
 *   npx tsx scripts/test-pricelists.ts
 *
 * Sprawdza: CRUD cenników, walidację nazwy (pusta / >80 znaków / duplikat 409),
 * niezmiennik „dokładnie jeden główny", zakaz usunięcia i dezaktywacji głównego,
 * duplikację z pozycjami, dodawanie/przenoszenie/kopiowanie pozycji, przypisania
 * techników w obie strony, usuwanie cennika z pozycjami (409 → ?force=1 przenosi
 * do głównego), zgodność wsteczną `GET /pricelist` bez parametru oraz prefill
 * wyceny wg technika / jawnego priceListId / domyślnego.
 *
 * Sprząta po sobie HARD (wszystko z prefiksem __PL_TEST__), także przy błędzie.
 * Realne dane usera (cennik główny i jego pozycje) nie są ruszane.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { eq, like, inArray } from "drizzle-orm";
import pricelist from "../src/routes/pricelist.js";
import technicians from "../src/routes/technicians.js";
import quotes from "../src/routes/quotes.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const PREFIX = "__PL_TEST__";

const app = new Hono();
app.route("/pricelist", pricelist);
app.route("/technicians", technicians);
app.route("/quotes", quotes);

type Res = { status: number; success?: boolean; data?: any; error?: string; message?: string };
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Res | null;
  return { status: res.status, ...(json ?? {}) };
}

/** Id cennika głównego przed testem — musi wrócić na swoje miejsce. */
const originalDefault = db
  .select()
  .from(schema.priceLists)
  .where(eq(schema.priceLists.isDefault, true))
  .all()[0];

function cleanup() {
  // Technicy testowi + odpięcie cennika od realnych techników, którym go podpięliśmy.
  const testLists = db
    .select()
    .from(schema.priceLists)
    .where(like(schema.priceLists.name, `${PREFIX}%`))
    .all();
  const ids = testLists.map((l) => l.id);
  if (ids.length > 0) {
    db.update(schema.technicians)
      .set({ priceListId: null })
      .where(inArray(schema.technicians.priceListId, ids))
      .run();
    db.delete(schema.priceList).where(inArray(schema.priceList.priceListId, ids)).run();
  }
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
  db.delete(schema.priceList).where(like(schema.priceList.name, `${PREFIX}%`)).run();
  // Domyślny musi wrócić na oryginał, zanim skasujemy testowe cenniki.
  if (originalDefault) {
    db.update(schema.priceLists).set({ isDefault: false }).run();
    db.update(schema.priceLists)
      .set({ isDefault: true })
      .where(eq(schema.priceLists.id, originalDefault.id))
      .run();
  }
  if (ids.length > 0) {
    db.delete(schema.priceLists).where(inArray(schema.priceLists.id, ids)).run();
  }
  db.delete(schema.quotes).where(like(schema.quotes.site, `${PREFIX}%`)).run();
}
cleanup();

async function main() {
  // -------------------------------------------------------------------------
  // 1. Stan wyjściowy: dokładnie jeden cennik główny, realne pozycje na miejscu
  // -------------------------------------------------------------------------
  let r = await call("GET", "/pricelist/lists");
  ok("GET /lists 200", r.status === 200 && Array.isArray(r.data), r);
  const defaults = (r.data as any[]).filter((l) => l.isDefault);
  ok("dokładnie jeden cennik główny", defaults.length === 1, defaults);
  const mainList = defaults[0];
  ok("główny ma licznik pozycji", typeof mainList.itemCount === "number", mainList);
  ok("główny ma licznik techników", typeof mainList.technicianCount === "number", mainList);
  const mainItemsBefore = mainList.itemCount;

  // Zgodność wsteczna: GET /pricelist bez parametru = pozycje cennika głównego
  r = await call("GET", "/pricelist");
  ok(
    "GET /pricelist bez parametru = pozycje głównego",
    r.status === 200 && r.data.length === mainItemsBefore,
    { got: r.data?.length, want: mainItemsBefore }
  );
  ok(
    "pozycje mają priceListId głównego",
    r.data.every((i: any) => i.priceListId === mainList.id),
    r.data?.[0]
  );

  // -------------------------------------------------------------------------
  // 2. CRUD cenników + walidacje
  // -------------------------------------------------------------------------
  r = await call("POST", "/pricelist/lists", { name: "   " });
  ok("pusta nazwa → 400", r.status === 400, r);

  r = await call("POST", "/pricelist/lists", { name: "x".repeat(81) });
  ok("nazwa >80 znaków → 400", r.status === 400, r);

  r = await call("POST", "/pricelist/lists", {
    name: `${PREFIX} Zewnętrzni`,
    description: "Stawki dla podwykonawców",
  });
  ok("POST /lists 201", r.status === 201 && r.data?.id > 0, r);
  const listA = r.data;
  ok("nowy cennik nie jest główny", listA.isDefault === false, listA);

  r = await call("POST", "/pricelist/lists", { name: `${PREFIX} Zewnętrzni` });
  ok("duplikat nazwy → 409", r.status === 409, r);

  r = await call("PUT", `/pricelist/lists/${listA.id}`, {
    name: `${PREFIX} Zewnętrzni A`,
    description: "opis 2",
  });
  ok(
    "PUT /lists/:id zmienia nazwę i opis",
    r.status === 200 && r.data.name === `${PREFIX} Zewnętrzni A` && r.data.description === "opis 2",
    r
  );

  r = await call("PUT", "/pricelist/lists/999999", { name: `${PREFIX} nope` });
  ok("PUT nieistniejącego → 404", r.status === 404, r);

  // -------------------------------------------------------------------------
  // 3. Pozycje w wybranym cenniku
  // -------------------------------------------------------------------------
  r = await call("POST", "/pricelist", {
    name: `${PREFIX} DOJAZD`,
    unit: "km",
    price: "2,50",
    priceListId: listA.id,
  });
  ok("POST pozycji z priceListId 201", r.status === 201 && r.data.priceListId === listA.id, r);
  ok("jednostka uppercase", r.data.unit === "KM", r.data);
  const itemA1 = r.data;

  r = await call("POST", "/pricelist", {
    name: `${PREFIX} RBH`,
    unit: "RBH",
    price: 90,
    priceListId: listA.id,
  });
  const itemA2 = r.data;

  r = await call("POST", "/pricelist", {
    name: `${PREFIX} NIEISTNIEJĄCY`,
    unit: "SZT",
    price: 1,
    priceListId: 999999,
  });
  ok("POST pozycji do nieistniejącego cennika → 404", r.status === 404, r);

  r = await call("GET", `/pricelist?listId=${listA.id}`);
  ok("GET ?listId= zwraca tylko pozycje tego cennika", r.status === 200 && r.data.length === 2, r);

  r = await call("GET", "/pricelist?listId=999999");
  ok("GET ?listId= nieistniejący → 404", r.status === 404, r);

  r = await call("GET", "/pricelist");
  ok(
    "główny cennik nadal ma swoje pozycje (bez testowych)",
    r.data.length === mainItemsBefore,
    { got: r.data?.length, want: mainItemsBefore }
  );

  // POST bez priceListId trafia do głównego (zgodność wsteczna)
  r = await call("POST", "/pricelist", { name: `${PREFIX} DO GŁÓWNEGO`, unit: "SZT", price: 1 });
  ok(
    "POST bez priceListId → cennik główny",
    r.status === 201 && r.data.priceListId === mainList.id,
    r
  );
  const itemInMain = r.data;

  // Przeniesienie pozycji między cennikami przez PUT
  r = await call("PUT", `/pricelist/${itemInMain.id}`, {
    name: `${PREFIX} DO GŁÓWNEGO`,
    unit: "SZT",
    price: 1,
    priceListId: listA.id,
  });
  ok(
    "PUT przenosi pozycję do innego cennika",
    r.status === 200 && r.data.priceListId === listA.id,
    r
  );

  r = await call("GET", "/pricelist");
  ok(
    "po przeniesieniu główny wraca do stanu wyjściowego",
    r.data.length === mainItemsBefore,
    { got: r.data?.length, want: mainItemsBefore }
  );

  // -------------------------------------------------------------------------
  // 4. Duplikacja cennika (z pozycjami)
  // -------------------------------------------------------------------------
  r = await call("POST", `/pricelist/lists/${listA.id}/duplicate`, {
    name: `${PREFIX} Kopia`,
  });
  ok("POST /duplicate 201", r.status === 201, r);
  const listB = r.data;
  ok("duplikat nie jest główny", listB.isDefault === false, listB);
  ok("duplikat ma skopiowane pozycje (3)", listB.itemCount === 3, listB);

  r = await call("GET", `/pricelist?listId=${listB.id}`);
  ok("pozycje duplikatu mają nowe id", r.data.length === 3 && r.data[0].id !== itemA1.id, r.data);
  ok(
    "pozycje duplikatu mają jego priceListId",
    r.data.every((i: any) => i.priceListId === listB.id),
    r.data
  );

  // Duplikat bez podanej nazwy → automatyczne „(kopia)" / „(kopia) 2"
  r = await call("POST", `/pricelist/lists/${listA.id}/duplicate`);
  ok("duplikat bez nazwy 201", r.status === 201, r);
  const listC = r.data;
  ok("auto-nazwa zawiera (kopia)", String(listC.name).includes("(kopia)"), listC);

  // -------------------------------------------------------------------------
  // 5. Kopiowanie wybranych pozycji między cennikami
  // -------------------------------------------------------------------------
  r = await call("POST", "/pricelist/copy", {
    fromListId: listA.id,
    toListId: listC.id,
    itemIds: [itemA1.id],
  });
  ok("POST /copy 201 (1 pozycja)", r.status === 201 && r.data.length === 1, r);
  ok("kopia trafia do docelowego", r.data[0].priceListId === listC.id, r.data[0]);

  r = await call("POST", "/pricelist/copy", { fromListId: listA.id, toListId: listA.id });
  ok("/copy do samego siebie → 400", r.status === 400, r);

  r = await call("POST", "/pricelist/copy", { fromListId: listA.id, toListId: 999999 });
  ok("/copy do nieistniejącego → 404", r.status === 404, r);

  // -------------------------------------------------------------------------
  // 6. Cennik główny: przełączanie, zakaz usunięcia i dezaktywacji
  // -------------------------------------------------------------------------
  r = await call("DELETE", `/pricelist/lists/${mainList.id}`);
  ok("DELETE cennika głównego → 400", r.status === 400, r);

  r = await call("PUT", `/pricelist/lists/${mainList.id}`, {
    name: mainList.name,
    description: mainList.description,
    active: false,
  });
  ok("dezaktywacja cennika głównego → 400", r.status === 400, r);

  r = await call("POST", `/pricelist/lists/${listA.id}/default`);
  ok("POST /default 200", r.status === 200 && r.data.isDefault === true, r);

  r = await call("GET", "/pricelist/lists");
  const nowDefault = (r.data as any[]).filter((l) => l.isDefault);
  ok("po przełączeniu nadal dokładnie jeden główny", nowDefault.length === 1, nowDefault);
  ok("główny to nowy cennik", nowDefault[0].id === listA.id, nowDefault[0]);

  r = await call("GET", "/pricelist");
  ok("GET /pricelist bez parametru podąża za nowym głównym", r.data.length === 3, {
    got: r.data?.length,
  });

  // Wracamy do oryginalnego głównego
  r = await call("POST", `/pricelist/lists/${mainList.id}/default`);
  ok("powrót do oryginalnego głównego", r.status === 200, r);

  // -------------------------------------------------------------------------
  // 7. Przypisania techników — oba kierunki
  // -------------------------------------------------------------------------
  r = await call("POST", "/technicians", {
    firstName: "Test",
    lastName: `${PREFIX} Kowalski`,
    type: "external",
  });
  ok("POST technika 201", r.status === 201, r);
  const tech1 = r.data;
  ok("nowy technik bez cennika (główny)", tech1.priceListId === null, tech1);

  r = await call("POST", "/technicians", {
    firstName: "Test2",
    lastName: `${PREFIX} Nowak`,
    type: "external",
    priceListId: listA.id,
  });
  ok("POST technika z cennikiem", r.status === 201 && r.data.priceListId === listA.id, r);
  const tech2 = r.data;

  r = await call("POST", "/technicians", {
    firstName: "X",
    lastName: `${PREFIX} Zły`,
    type: "external",
    priceListId: 999999,
  });
  ok("POST technika z nieistniejącym cennikiem → 404", r.status === 404, r);

  // Kierunek 1: PUT /technicians/:id
  r = await call("PUT", `/technicians/${tech1.id}`, {
    firstName: "Test",
    lastName: `${PREFIX} Kowalski`,
    type: "external",
    priceListId: listB.id,
  });
  ok("PUT technika ustawia cennik", r.status === 200 && r.data.priceListId === listB.id, r);

  r = await call("PUT", `/technicians/${tech1.id}`, {
    firstName: "Test",
    lastName: `${PREFIX} Kowalski`,
    type: "external",
    priceListId: null,
  });
  ok("PUT technika z null zdejmuje cennik", r.status === 200 && r.data.priceListId === null, r);

  // Kierunek 2: PUT /pricelist/lists/:id/technicians
  r = await call("PUT", `/pricelist/lists/${listA.id}/technicians`, {
    technicianIds: [tech1.id, tech2.id],
  });
  ok("PUT /lists/:id/technicians 200 (2)", r.status === 200 && r.data.length === 2, r);

  r = await call("GET", `/pricelist/lists/${listA.id}/technicians`);
  ok("GET /lists/:id/technicians zwraca 2", r.status === 200 && r.data.length === 2, r);

  r = await call("PUT", `/pricelist/lists/${listA.id}/technicians`, {
    technicianIds: [tech2.id],
  });
  ok("zawężenie listy zdejmuje pozostałych", r.status === 200 && r.data.length === 1, r);

  r = await call("GET", "/technicians");
  const t1 = (r.data as any[]).find((t) => t.id === tech1.id);
  ok("zdjęty technik ma priceListId null", t1?.priceListId === null, t1);

  r = await call("PUT", `/pricelist/lists/${listA.id}/technicians`, {
    technicianIds: [999999],
  });
  ok("nieistniejący technik → 400", r.status === 400, r);

  r = await call("PUT", `/pricelist/lists/${listA.id}/technicians`, { technicianIds: "x" });
  ok("technicianIds nie-lista → 400", r.status === 400, r);

  r = await call("GET", "/pricelist/lists");
  const withTechs = (r.data as any[]).find((l) => l.id === listA.id);
  ok("licznik techników w /lists", withTechs.technicianCount === 1, withTechs);

  // -------------------------------------------------------------------------
  // 8. Prefill wyceny: technik → jego cennik, jawny listId, domyślny
  // -------------------------------------------------------------------------
  r = await call("POST", "/quotes", { site: `${PREFIX} obiekt` });
  ok("nowa wycena bez kontekstu = cennik główny", r.status === 201 && r.data.items.length === mainItemsBefore, {
    got: r.data?.items?.length,
    want: mainItemsBefore,
  });

  r = await call("POST", "/quotes", { site: `${PREFIX} obiekt`, technicianId: tech2.id });
  ok(
    "wycena z technicianId = cennik technika",
    r.status === 201 && r.data.items.length === 3,
    { got: r.data?.items?.length }
  );
  ok(
    "pozycje wyceny z cennika technika",
    r.data.items.some((i: any) => i.name === `${PREFIX} DOJAZD`),
    r.data?.items
  );

  r = await call("POST", "/quotes", { site: `${PREFIX} obiekt`, technicianId: tech1.id });
  ok(
    "wycena z technikiem bez cennika = główny",
    r.status === 201 && r.data.items.length === mainItemsBefore,
    { got: r.data?.items?.length }
  );

  r = await call("POST", "/quotes", { site: `${PREFIX} obiekt`, priceListId: listB.id });
  ok("wycena z jawnym priceListId", r.status === 201 && r.data.items.length === 3, {
    got: r.data?.items?.length,
  });

  r = await call("POST", `/quotes?priceListId=${listB.id}`, { site: `${PREFIX} obiekt` });
  ok("wycena z ?priceListId= w query", r.status === 201 && r.data.items.length === 3, {
    got: r.data?.items?.length,
  });

  r = await call("POST", "/quotes", { site: `${PREFIX} obiekt`, priceListId: 999999 });
  ok(
    "nieistniejący priceListId → fallback na główny",
    r.status === 201 && r.data.items.length === mainItemsBefore,
    { got: r.data?.items?.length }
  );

  // -------------------------------------------------------------------------
  // 9. Usuwanie cennika: 409 przy pozycjach/technikach, ?force=1 przenosi
  // -------------------------------------------------------------------------
  r = await call("DELETE", `/pricelist/lists/${listA.id}`);
  ok("DELETE cennika z pozycjami/technikami → 409", r.status === 409, r);
  ok("409 opisuje skutki", /poz\. cennika/.test(r.error || ""), r.error);

  r = await call("DELETE", `/pricelist/lists/${listB.id}`);
  ok("DELETE cennika z samymi pozycjami → 409", r.status === 409, r);

  const mainBeforeForce = (await call("GET", "/pricelist")).data.length;
  r = await call("DELETE", `/pricelist/lists/${listB.id}?force=1`);
  ok("DELETE ?force=1 200", r.status === 200, r);

  r = await call("GET", "/pricelist");
  ok(
    "pozycje usuniętego cennika trafiły do głównego",
    r.data.length === mainBeforeForce + 3,
    { got: r.data?.length, want: mainBeforeForce + 3 }
  );

  // Posprzątaj przeniesione pozycje z cennika głównego (to dane testowe).
  const moved = (r.data as any[]).filter((i) => String(i.name).startsWith(PREFIX));
  for (const i of moved) await call("DELETE", `/pricelist/${i.id}`);
  r = await call("GET", "/pricelist");
  ok("główny cennik wrócił do stanu wyjściowego", r.data.length === mainItemsBefore, {
    got: r.data?.length,
    want: mainItemsBefore,
  });

  r = await call("DELETE", `/pricelist/lists/${listA.id}?force=1`);
  ok("DELETE ?force=1 zdejmuje też techników", r.status === 200, r);
  r = await call("GET", "/technicians");
  const t2 = (r.data as any[]).find((t) => t.id === tech2.id);
  ok("technik po usunięciu cennika wraca na główny", t2?.priceListId === null, t2);

  r = await call("DELETE", "/pricelist/lists/999999");
  ok("DELETE nieistniejącego → 404", r.status === 404, r);
}

try {
  await main();
} catch (err) {
  console.error("Wyjątek w teście:", err);
  failures++;
} finally {
  cleanup();
  const left = db
    .select()
    .from(schema.priceLists)
    .where(like(schema.priceLists.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych cenników", left.length === 0, left);
  const leftItems = db
    .select()
    .from(schema.priceList)
    .where(like(schema.priceList.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych pozycji", leftItems.length === 0, leftItems);
  const stillDefault = db
    .select()
    .from(schema.priceLists)
    .where(eq(schema.priceLists.isDefault, true))
    .all();
  ok(
    "sprzątanie: główny cennik przywrócony",
    stillDefault.length === 1 && stillDefault[0].id === originalDefault?.id,
    stillDefault
  );
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 1 - 1 : 1);
