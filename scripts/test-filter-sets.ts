/**
 * Test zapisanych zestawów filtrów kalendarza (calendar_filter_sets) na prawdziwej bazie
 * (data/alfa.db), przez trasy Hono (app.request) z podstawionym userem w kontekście:
 *   npx tsx scripts/test-filter-sets.ts
 *
 * Sprawdza: CRUD, walidację nazwy (pusta / >60 znaków / trim), walidację filters (nie-obiekt →
 * 400, nieznane klucze i wartości pomijane), unikalność nazwy w obrębie usera (409), limit 20
 * zestawów, izolację między userami (cudzy zestaw → 404) i przełączanie domyślnego.
 * Sprząta po sobie HARD (zestawy o nazwach z prefiksem), także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { and, eq, like, or } from "drizzle-orm";
import filterSets from "../src/routes/calendar-filter-sets.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__FS_TEST__";

const users = db.select().from(schema.users).limit(2).all() as User[];
if (users.length < 2) {
  console.error("Potrzeba co najmniej 2 użytkowników w bazie — przerywam.");
  process.exit(1);
}
const [userA, userB] = users;

function cleanup() {
  const res = db
    .delete(schema.calendarFilterSets)
    .where(like(schema.calendarFilterSets.name, `${PREFIX}%`))
    .run();
  return res.changes;
}
cleanup();

/** Klient HTTP dla danego usera (podstawia kontekst tak, jak robi requireAuth). */
function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.route("/filter-sets", filterSets);
  return async (method: string, path: string, body?: unknown) => {
    // Hono jest „strict” wobec ukośnika na końcu: "/" → "" (czyli /filter-sets).
    const res = await app.request(`/filter-sets${path === "/" ? "" : path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown; error?: string } | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

const A = clientFor(userA);
const B = clientFor(userB);

const BASE_FILTERS = {
  types: ["serwis", "montaz"],
  statuses: ["planned"],
  billings: ["paid", "none"],
  technicianIds: [1, 2],
  protocol: "without",
  realization: "",
};

interface SetJson {
  id: number;
  name: string;
  filters: Record<string, unknown>;
  isDefault: boolean;
  sortOrder: number;
}

async function main() {
  // --- 1. Tworzenie ---
  const created = await A("POST", "/", { name: `${PREFIX} Serwisy Wojtka `, filters: BASE_FILTERS });
  ok("POST /filter-sets → 201", created.status === 201, created);
  const set = created.data as SetJson;
  ok("nazwa przycięta (trim)", set?.name === `${PREFIX} Serwisy Wojtka`, set?.name);
  ok("filters zserializowane 1:1", JSON.stringify(set?.filters) === JSON.stringify(BASE_FILTERS), set?.filters);
  ok("nowy zestaw nie jest domyślny", set?.isDefault === false, set);

  // --- 2. Walidacja nazwy ---
  const emptyName = await A("POST", "/", { name: "   ", filters: {} });
  ok("pusta nazwa → 400", emptyName.status === 400, emptyName);
  const longName = await A("POST", "/", { name: PREFIX + "x".repeat(61), filters: {} });
  ok("nazwa > 60 znaków → 400", longName.status === 400, longName);
  const name60 = PREFIX + "y".repeat(60 - PREFIX.length);
  const okName = await A("POST", "/", { name: name60, filters: {} });
  ok("nazwa = 60 znaków → 201", okName.status === 201, okName);

  // --- 3. Walidacja filters ---
  const badFilters = await A("POST", "/", { name: `${PREFIX} zle`, filters: "nie-obiekt" });
  ok("filters jako string → 400", badFilters.status === 400, badFilters);
  const arrFilters = await A("POST", "/", { name: `${PREFIX} zle2`, filters: [1, 2] });
  ok("filters jako tablica → 400", arrFilters.status === 400, arrFilters);
  const dirty = await A("POST", "/", {
    name: `${PREFIX} brudny`,
    filters: {
      types: ["serwis", "NIE_MA_TAKIEGO", 42],
      statuses: ["planned", "zombie"],
      billings: ["paid", "kredyt", "none"],
      technicianIds: [3, -1, 0, "x", 3],
      protocol: "wtf",
      realization: "with",
      view: "timeGridWeek",
      weekends: true,
      dropMe: "hasta la vista",
      sql: "DROP TABLE users",
    },
  });
  ok("nieznane wartości/klucze pominięte → 201", dirty.status === 201, dirty);
  const df = (dirty.data as SetJson)?.filters as Record<string, unknown>;
  ok("types przefiltrowane", JSON.stringify(df?.types) === JSON.stringify(["serwis"]), df?.types);
  ok("statuses przefiltrowane", JSON.stringify(df?.statuses) === JSON.stringify(["planned"]), df?.statuses);
  ok("billings przefiltrowane", JSON.stringify(df?.billings) === JSON.stringify(["paid", "none"]), df?.billings);
  ok("technicianIds: tylko dodatnie int, bez duplikatów", JSON.stringify(df?.technicianIds) === JSON.stringify([3]), df?.technicianIds);
  ok("protocol nieznany → ''", df?.protocol === "", df?.protocol);
  ok("realization zachowany", df?.realization === "with", df?.realization);
  ok("view zachowany", df?.view === "timeGridWeek", df?.view);
  ok("weekends zachowany", df?.weekends === true, df?.weekends);
  ok("nieznane klucze usunięte", !("dropMe" in (df ?? {})) && !("sql" in (df ?? {})), Object.keys(df ?? {}));

  // --- 4. Unikalna nazwa ---
  const dup = await A("POST", "/", { name: `${PREFIX} Serwisy Wojtka`, filters: {} });
  ok("duplikat nazwy → 409", dup.status === 409, dup);
  const dupOtherUser = await B("POST", "/", { name: `${PREFIX} Serwisy Wojtka`, filters: {} });
  ok("ta sama nazwa u innego usera → 201", dupOtherUser.status === 201, dupOtherUser);
  const bSet = dupOtherUser.data as SetJson;

  // --- 5. Lista (tylko własne) ---
  const listA = await A("GET", "/");
  const rowsA = (listA.data as SetJson[]) || [];
  ok("GET zwraca tylko własne zestawy", rowsA.every((r) => r.id !== bSet.id) && rowsA.length === 3, rowsA.map((r) => r.name));
  ok("sortOrder rośnie", rowsA.map((r) => r.sortOrder).join(",") === "0,1,2", rowsA.map((r) => r.sortOrder));

  // --- 6. Cudzy zestaw ---
  const foreignGet = await A("PUT", `/${bSet.id}`, { name: `${PREFIX} hack` });
  ok("PUT cudzego zestawu → 404", foreignGet.status === 404, foreignGet);
  const foreignDefault = await A("POST", `/${bSet.id}/default`);
  ok("POST cudzy /default → 404", foreignDefault.status === 404, foreignDefault);
  const foreignDelete = await A("DELETE", `/${bSet.id}`);
  ok("DELETE cudzego zestawu → 404", foreignDelete.status === 404, foreignDelete);
  const stillThere = await B("GET", "/");
  ok("zestaw usera B nietknięty", ((stillThere.data as SetJson[]) || []).some((r) => r.id === bSet.id), stillThere.data);
  const missing = await A("DELETE", "/999999999");
  ok("DELETE nieistniejącego → 404", missing.status === 404, missing);
  const badId = await A("PUT", "/abc", { name: `${PREFIX} x` });
  ok("PUT z nieliczbowym id → 404", badId.status === 404, badId);

  // --- 7. Zmiana nazwy i nadpisanie filtrów ---
  const renamed = await A("PUT", `/${set.id}`, { name: `${PREFIX} Serwisy Wojtka 2` });
  ok("PUT zmiana nazwy → 200", renamed.status === 200 && (renamed.data as SetJson).name === `${PREFIX} Serwisy Wojtka 2`, renamed);
  const overwritten = await A("PUT", `/${set.id}`, { filters: { types: ["urlop"], protocol: "with" } });
  const of = (overwritten.data as SetJson)?.filters as Record<string, unknown>;
  ok("PUT nadpisanie filtrów", JSON.stringify(of?.types) === JSON.stringify(["urlop"]) && of?.protocol === "with", of);
  ok("brakujące klucze → puste wartości", JSON.stringify(of?.statuses) === "[]" && of?.realization === "", of);
  const renameToTaken = await A("PUT", `/${set.id}`, { name: name60 });
  ok("PUT na zajętą nazwę → 409", renameToTaken.status === 409, renameToTaken);
  const renameToSelf = await A("PUT", `/${set.id}`, { name: `${PREFIX} Serwisy Wojtka 2` });
  ok("PUT na własną (niezmienioną) nazwę → 200", renameToSelf.status === 200, renameToSelf);
  const badSort = await A("PUT", `/${set.id}`, { sortOrder: "pierwszy" });
  ok("PUT sortOrder nie-int → 400", badSort.status === 400, badSort);

  // --- 8. Domyślny zestaw ---
  const def1 = await A("POST", `/${set.id}/default`);
  ok("POST /default → 200", def1.status === 200, def1);
  const afterDef1 = (def1.data as SetJson[]) || [];
  ok("dokładnie 1 domyślny", afterDef1.filter((r) => r.isDefault).length === 1, afterDef1.map((r) => [r.name, r.isDefault]));
  ok("domyślny to właściwy zestaw", afterDef1.find((r) => r.isDefault)?.id === set.id, afterDef1);
  const second = rowsA.find((r) => r.id !== set.id)!;
  const def2 = await A("POST", `/${second.id}/default`);
  const afterDef2 = (def2.data as SetJson[]) || [];
  ok("przełączenie domyślnego odznacza poprzedni", afterDef2.filter((r) => r.isDefault).length === 1 && afterDef2.find((r) => r.isDefault)?.id === second.id, afterDef2.map((r) => [r.name, r.isDefault]));
  const bDefaults = ((await B("GET", "/")).data as SetJson[]) || [];
  ok("domyślny usera A nie ruszył usera B", bDefaults.every((r) => !r.isDefault) || bDefaults.length === 0, bDefaults);
  // isDefault:true przy tworzeniu
  const createdDefault = await A("POST", "/", { name: `${PREFIX} domyslny`, filters: {}, isDefault: true });
  const afterCreateDef = ((await A("GET", "/")).data as SetJson[]) || [];
  ok("POST z isDefault:true → jedyny domyślny", createdDefault.status === 201 && afterCreateDef.filter((r) => r.isDefault).length === 1 && afterCreateDef.find((r) => r.isDefault)?.id === (createdDefault.data as SetJson).id, afterCreateDef.map((r) => [r.name, r.isDefault]));
  // PUT isDefault:false — odznaczenie
  const unset = await A("PUT", `/${(createdDefault.data as SetJson).id}`, { isDefault: false });
  ok("PUT isDefault:false odznacza", unset.status === 200 && (unset.data as SetJson).isDefault === false, unset);

  // --- 9. Limit 20 ---
  const have = ((await A("GET", "/")).data as SetJson[]).length;
  for (let i = have; i < 20; i++) {
    const r = await A("POST", "/", { name: `${PREFIX} fill ${i}`, filters: {} });
    if (r.status !== 201) ok(`wypełnianie do 20 (#${i})`, false, r);
  }
  const atLimit = ((await A("GET", "/")).data as SetJson[]).length;
  ok("dokładnie 20 zestawów", atLimit === 20, atLimit);
  const over = await A("POST", "/", { name: `${PREFIX} nadmiar`, filters: {} });
  ok("21. zestaw → 400 (limit)", over.status === 400 && /Limit 20/.test(over.error || ""), over);
  ok("limit nie dotyczy innego usera", (await B("POST", "/", { name: `${PREFIX} b2`, filters: {} })).status === 201);

  // --- 10. Usuwanie ---
  const del = await A("DELETE", `/${set.id}`);
  ok("DELETE → 200", del.status === 200 && (del.data as { id: number }).id === set.id, del);
  const afterDel = ((await A("GET", "/")).data as SetJson[]) || [];
  ok("po usunięciu 19 zestawów", afterDel.length === 19, afterDel.length);
  ok("usunięty zniknął z listy", !afterDel.some((r) => r.id === set.id));
  const afterDelAdd = await A("POST", "/", { name: `${PREFIX} po zwolnieniu miejsca`, filters: {} });
  ok("po usunięciu można znów dodać", afterDelAdd.status === 201, afterDelAdd);

  // --- 11. Kaskada po usunięciu usera (bez usuwania usera: sprawdzamy FK w schemacie) ---
  const fk = db.all<{ table: string; on_delete: string }>(
    `SELECT "table", "on_delete" FROM pragma_foreign_key_list('calendar_filter_sets')`
  );
  ok("FK user_id → users ON DELETE CASCADE", fk.some((r) => r.table === "users" && r.on_delete === "CASCADE"), fk);
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("BŁĄD:", err);
} finally {
  const removed = cleanup();
  console.log(`\nSprzątanie: usunięto ${removed} zestawów testowych.`);
  const leftovers = db
    .select({ id: schema.calendarFilterSets.id })
    .from(schema.calendarFilterSets)
    .where(
      and(
        or(eq(schema.calendarFilterSets.userId, userA.id), eq(schema.calendarFilterSets.userId, userB.id)),
        like(schema.calendarFilterSets.name, `${PREFIX}%`)
      )
    )
    .all();
  if (leftovers.length) {
    failures++;
    console.log(`FAIL sprzątanie: zostało ${leftovers.length} zestawów`);
  }
  console.log(failures ? `\n❌ Niepowodzenia: ${failures}` : "\n✅ Wszystkie testy przeszły");
  process.exit(failures ? 1 : 0);
}
