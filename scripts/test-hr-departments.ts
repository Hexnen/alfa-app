/**
 * Test działów firmy (Kadry → Działy) i ich roli w ewidencji godzin:
 *   npx tsx scripts/test-on-copy.ts scripts/test-hr-departments.ts
 *
 * Do tej pory tras `/hr/hours` nie pilnował ŻADEN test, a carry-over jest jedyną
 * logiką w module, która sama tworzy wiersze godzin — po rozdzieleniu obiektów
 * i działów przenosi teraz dwa rodzaje przypisania naraz.
 *
 * Sprawdza:
 *  1. CRUD działów: zakładanie, duplikat nazwy, edycja częściowa, etykieta z nazwą firmy.
 *  2. Niezmiennik puli: zaznaczenie `is_cma_pool` zdejmuje flagę z pozostałych działów.
 *  3. Rozłączność przypisania: wpis godzin nie może wskazywać obiektu i działu naraz,
 *     a przepięcie obiekt → dział zeruje `object_id`.
 *  4. Carry-over przenosi parę (pracownik, dział) i nie dubluje przy drugim wywołaniu.
 *  5. MIANOWNIK ALOKACJI — godziny działowe zostają w `entry.total`, więc pracownik
 *     z połową godzin na dziale oddaje obiektowi dokładnie połowę swojego kosztu.
 *     To asercja pilnująca jednej linii w `object-personnel-cost.ts`: gdyby wiersz
 *     działowy pomijać PRZED inkrementacją sumy, obiekty wchłonęłyby koszt Handlowego
 *     i Księgowości — cicho, bez błędu, z zawyżonym kosztem obiektu.
 *  6. Usunięcie działu z godzinami wymaga potwierdzenia (409 → `?force=1`).
 *
 * Sprząta po sobie HARD, także przy błędzie.
 *
 * Nie ma tu frameworka testowego — to konwencja z pozostałych scripts/test-*.ts.
 */
import { and, eq, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import hrApp from "../src/routes/hr.js";
import {
  clearPersonnelCostCache,
  computeObjectPersonnelCost,
  fullMonths,
} from "../src/lib/object-personnel-cost.js";
import { COMPANY_FIELDS } from "../src/lib/company-config.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

/**
 * BLOKADA: test podmienia GLOBALNE ustawienie `company.name` (żeby sprawdzić prefiks
 * etykiety) i zakłada dział z flagą puli, która wpływa na koszt CAŁEJ firmy.
 * Odtworzenie wisi na `finally`, więc przerwany proces zostawiłby produkcyjną bazę
 * z cudzą nazwą firmy. Dlatego wymagamy jawnie wskazanej bazy.
 */
if (!process.env.ALFA_DB_PATH) {
  console.error(
    "Ten test zmienia ustawienia globalne, więc nie uruchamia się na domyślnej bazie.\n" +
      "Użyj:  npx tsx scripts/test-on-copy.ts scripts/test-hr-departments.ts"
  );
  process.exit(1);
}

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
const near = (a: number | null | undefined, b: number, eps = 0.01) =>
  a !== null && a !== undefined && Math.abs(a - b) < eps;

const PREFIX = "__ZZ_DEPT__";
const COMPANY_NAME = "ZZ TEST SP. Z O.O.";
const NAME_KEY = COMPANY_FIELDS.companyName.dbKey;

/** Stan sprzed testu: wartość albo null („wpisu nie było") — to dwa różne stany. */
let savedCompanyName: string | null = null;
let companyNameStashed = false;

function restoreCompanyName() {
  if (!companyNameStashed) return;
  if (savedCompanyName === null) deleteSetting(NAME_KEY);
  else setSetting(NAME_KEY, savedCompanyName, null);
  companyNameStashed = false;
}

/** Wywołanie trasy `/hr/*` z pominięciem middleware — jak w pozostałych testach. */
async function call(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; body: any }> {
  const res = await hrApp.request(path, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function cleanup() {
  restoreCompanyName();
  const empIds = db
    .select({ id: schema.hrEmployees.id })
    .from(schema.hrEmployees)
    .where(like(schema.hrEmployees.fullName, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  for (const id of empIds) {
    const contractIds = db
      .select({ id: schema.hrContracts.id })
      .from(schema.hrContracts)
      .where(eq(schema.hrContracts.employeeId, id))
      .all()
      .map((r) => r.id);
    for (const cid of contractIds) {
      db.delete(schema.hrPayroll).where(eq(schema.hrPayroll.contractId, cid)).run();
    }
    db.delete(schema.hrContracts).where(eq(schema.hrContracts.employeeId, id)).run();
    db.delete(schema.hrHours).where(eq(schema.hrHours.employeeId, id)).run();
    db.delete(schema.hrEmployees).where(eq(schema.hrEmployees.id, id)).run();
  }
  db.delete(schema.hrDepartments).where(like(schema.hrDepartments.name, `${PREFIX}%`)).run();
  db.delete(schema.hrObjects).where(like(schema.hrObjects.name, `${PREFIX}%`)).run();
  db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run();
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  clearPersonnelCostCache();
}

async function main() {
  cleanup();

  const [m1] = fullMonths(1);

  console.log("\n— CRUD działów —");

  savedCompanyName = getSetting(NAME_KEY);
  companyNameStashed = true;
  setSetting(NAME_KEY, COMPANY_NAME, null);

  const created = await call("/departments", {
    method: "POST",
    body: { name: `${PREFIX}Handlowy` },
  });
  ok("POST /departments zakłada dział", created.status === 201 && created.body?.success === true, created);
  const depHandlowy = created.body?.data;
  ok(
    "etykieta niesie prefiks z nazwy firmy z ustawień",
    depHandlowy?.label === `${COMPANY_NAME}:${PREFIX}Handlowy`,
    depHandlowy?.label
  );

  const dup = await call("/departments", { method: "POST", body: { name: `${PREFIX}handlowy` } });
  ok("duplikat nazwy (bez względu na wielkość liter) → 409", dup.status === 409, dup);

  const empty = await call("/departments", { method: "POST", body: { name: "   " } });
  ok("pusta nazwa → 400", empty.status === 400, empty);

  const renamed = await call(`/departments/${depHandlowy.id}`, {
    method: "PUT",
    body: { sortOrder: 25 },
  });
  ok(
    "PUT częściowy zmienia tylko podane pola",
    renamed.status === 200 &&
      renamed.body?.data?.sortOrder === 25 &&
      renamed.body?.data?.name === `${PREFIX}Handlowy`,
    renamed.body?.data
  );

  const missing = await call("/departments/99999999", { method: "PUT", body: { name: "x" } });
  ok("PUT nieistniejącego działu → 404", missing.status === 404, missing);

  console.log("\n— niezmiennik puli —");

  const poolA = await call("/departments", {
    method: "POST",
    body: { name: `${PREFIX}CMA_A`, isCmaPool: true },
  });
  const poolB = await call("/departments", {
    method: "POST",
    body: { name: `${PREFIX}CMA_B`, isCmaPool: true },
  });
  const poolCount = db
    .select({ id: schema.hrDepartments.id })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.isCmaPool, true))
    .all().length;
  ok(
    "drugi dział z pulą zdejmuje flagę pierwszemu — pula jest jedna w całej bazie",
    poolCount === 1 && poolB.body?.data?.isCmaPool === true,
    { poolCount, a: poolA.body?.data?.isCmaPool, b: poolB.body?.data?.isCmaPool }
  );

  console.log("\n— rozłączność przypisania —");

  const [contractor] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent`, nip: `${PREFIX}1` })
    .returning()
    .all();
  const mkObject = (name: string) =>
    db
      .insert(schema.objects)
      .values({
        contractorId: contractor.id,
        name: `${PREFIX}${name}`,
        type: "monitoring",
        installationType: "new",
        status: "active",
      })
      .returning()
      .all()[0];
  const oSolo = mkObject("SOLO");
  const oHalf = mkObject("POLOWA");

  const mkPosition = (name: string, objectId: number) =>
    db
      .insert(schema.hrObjects)
      .values({ name: `${PREFIX}${name}`, objectId })
      .returning()
      .all()[0];
  const posSolo = mkPosition("POS_SOLO", oSolo.id);
  const posHalf = mkPosition("POS_POLOWA", oHalf.id);

  const [empSwitch] = db
    .insert(schema.hrEmployees)
    .values({ fullName: `${PREFIX}Przepinany`, kind: "ochrona", active: true })
    .returning()
    .all();

  const bothIds = await call("/hours", {
    method: "POST",
    body: {
      employeeId: empSwitch.id,
      objectId: posSolo.id,
      departmentId: depHandlowy.id,
      year: m1.year,
      month: m1.month,
      workedHours: 100,
    },
  });
  ok("POST /hours z obiektem I działem naraz → 400", bothIds.status === 400, bothIds);

  const onObject = await call("/hours", {
    method: "POST",
    body: {
      employeeId: empSwitch.id,
      objectId: posSolo.id,
      year: m1.year,
      month: m1.month,
      workedHours: 100,
    },
  });
  ok("POST /hours na obiekcie przechodzi", onObject.status === 201 || onObject.status === 200, onObject);
  const hoursRow = onObject.body?.data;

  // PUT zastępuje CAŁY wiersz (front wysyła komplet pól), więc ciała są pełne.
  // Gdyby brakowało pracownika albo miesiąca, 400 przyszłoby z innego powodu
  // i asercja o rozłączności przechodziłaby, nie sprawdzając niczego.
  const hoursBase = { employeeId: empSwitch.id, year: m1.year, month: m1.month, workedHours: 100 };

  const badPut = await call(`/hours/${hoursRow.id}`, {
    method: "PUT",
    body: { ...hoursBase, objectId: posSolo.id, departmentId: depHandlowy.id },
  });
  ok(
    "PUT /hours z obydwoma id → 400 (i to z powodu rozłączności, nie braku pól)",
    badPut.status === 400 && /obiekt albo dział/.test(String(badPut.body?.error)),
    badPut
  );

  const toDept = await call(`/hours/${hoursRow.id}`, {
    method: "PUT",
    body: { ...hoursBase, objectId: null, departmentId: depHandlowy.id },
  });
  const afterSwitch = db
    .select()
    .from(schema.hrHours)
    .where(eq(schema.hrHours.id, hoursRow.id))
    .get();
  ok(
    "przepięcie obiekt → dział zeruje object_id",
    toDept.status === 200 && afterSwitch?.departmentId === depHandlowy.id && afterSwitch?.objectId === null,
    { status: toDept.status, error: toDept.body?.error, row: afterSwitch }
  );

  console.log("\n— carry-over —");

  const next = m1.month === 12 ? { year: m1.year + 1, month: 1 } : { year: m1.year, month: m1.month + 1 };
  db.delete(schema.hrHours)
    .where(
      and(
        eq(schema.hrHours.employeeId, empSwitch.id),
        eq(schema.hrHours.year, next.year),
        eq(schema.hrHours.month, next.month)
      )
    )
    .run();

  const carry1 = await call("/hours/carry-over", { method: "POST", body: { ...next } });
  const carried = db
    .select()
    .from(schema.hrHours)
    .where(
      and(
        eq(schema.hrHours.employeeId, empSwitch.id),
        eq(schema.hrHours.year, next.year),
        eq(schema.hrHours.month, next.month)
      )
    )
    .all();
  ok(
    "carry-over przenosi parę (pracownik, dział) — nie gubi przypisania",
    carry1.status === 200 &&
      carried.length === 1 &&
      carried[0].departmentId === depHandlowy.id &&
      carried[0].objectId === null,
    carried
  );
  ok("przeniesiony wpis jest oznaczony do potwierdzenia", carried[0]?.objectUncertain === true, carried[0]);

  await call("/hours/carry-over", { method: "POST", body: { ...next } });
  const carriedTwice = db
    .select({ id: schema.hrHours.id })
    .from(schema.hrHours)
    .where(
      and(
        eq(schema.hrHours.employeeId, empSwitch.id),
        eq(schema.hrHours.year, next.year),
        eq(schema.hrHours.month, next.month)
      )
    )
    .all();
  ok("drugie wywołanie carry-over niczego nie dubluje", carriedTwice.length === 1, carriedTwice);

  console.log("\n— mianownik alokacji kosztu —");

  /**
   * Dwaj pracownicy z IDENTYCZNĄ wypłatą. Pierwszy ma wszystkie godziny na posterunku
   * zmapowanym na SOLO, drugi połowę na posterunku zmapowanym na POŁOWA, a połowę
   * na dziale spoza puli. Porównujemy STOSUNEK, nie kwoty — dzięki temu asercja nie
   * zależy od narzutu składkowego ustawionego w bazie.
   */
  const mkEmployee = (name: string, amount: number) => {
    const [e] = db
      .insert(schema.hrEmployees)
      .values({ fullName: `${PREFIX}${name}`, kind: "ochrona", active: true })
      .returning()
      .all();
    const [ct] = db
      .insert(schema.hrContracts)
      .values({
        employeeId: e.id,
        company: `${PREFIX}SP`,
        contractType: "zlecenie",
        zua: "tak",
        mainChannel: "przelew",
        bonusType: "brak",
        active: true,
      })
      .returning()
      .all();
    db.insert(schema.hrPayroll)
      .values({ contractId: ct.id, year: m1.year, month: m1.month, mainAmount: amount })
      .run();
    return e;
  };

  const empSolo = mkEmployee("Solo", 3000);
  db.insert(schema.hrHours)
    .values({
      employeeId: empSolo.id,
      objectId: posSolo.id,
      year: m1.year,
      month: m1.month,
      workedHours: 100,
    })
    .run();

  const empHalf = mkEmployee("Polowa", 3000);
  db.insert(schema.hrHours)
    .values({
      employeeId: empHalf.id,
      objectId: posHalf.id,
      year: m1.year,
      month: m1.month,
      workedHours: 100,
    })
    .run();
  db.insert(schema.hrHours)
    .values({
      employeeId: empHalf.id,
      departmentId: depHandlowy.id,
      year: m1.year,
      month: m1.month,
      workedHours: 100,
    })
    .run();

  clearPersonnelCostCache();
  const cost = computeObjectPersonnelCost(1);
  const costSolo = cost.directByObjectId.get(oSolo.id) ?? 0;
  const costHalf = cost.directByObjectId.get(oHalf.id) ?? 0;

  ok("kontrola: obiekt z pełnym etatem ma koszt > 0", costSolo > 0, { costSolo });
  ok(
    "pracownik z połową godzin na dziale oddaje obiektowi DOKŁADNIE połowę kosztu",
    near(costHalf, costSolo / 2),
    { costSolo, costHalf, iloraz: costSolo === 0 ? null : costHalf / costSolo }
  );
  ok(
    "godziny działowe nie znikają z mianownika — obiekt nie wchłania kosztu działu",
    !near(costHalf, costSolo),
    { costSolo, costHalf }
  );
  ok(
    "godziny działowe liczą się jako nierozdzielone",
    cost.unmappedHoursShare > 0,
    cost.unmappedHoursShare
  );

  console.log("\n— usuwanie działu —");

  const delBlocked = await call(`/departments/${depHandlowy.id}`, { method: "DELETE" });
  ok("usunięcie działu z godzinami → 409 z liczbą wpisów", delBlocked.status === 409, delBlocked);

  const delForced = await call(`/departments/${depHandlowy.id}?force=1`, { method: "DELETE" });
  const orphan = db
    .select({ id: schema.hrHours.id })
    .from(schema.hrHours)
    .where(eq(schema.hrHours.departmentId, depHandlowy.id))
    .all();
  ok(
    "?force=1 usuwa dział i odpina godziny (FK SET NULL), nie kasując ich",
    delForced.status === 200 && orphan.length === 0,
    { status: delForced.status, orphan: orphan.length }
  );
}

try {
  await main();
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} niepowodzeń`);
process.exit(failures === 0 ? 0 : 1);
