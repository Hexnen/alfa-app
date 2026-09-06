/**
 * Test dzierżawy sprzętu jako części przychodu obiektu (`objects.monthly_rental`):
 *   npx tsx scripts/test-object-rental.ts
 *
 * Do sierpnia 2026 konwersja zlecenia na obiekt przepisywała wyłącznie abonament,
 * a kwota dzierżawy zostawała na zleceniu — Analityka i lista obiektów pokazywały
 * zaniżony przychód. Ten test pilnuje, żeby dzierżawa liczyła się wszędzie tam,
 * gdzie liczy się abonament, i żeby obiekt bez dzierżawy zachowywał się jak dotąd.
 *
 * Sprząta po sobie HARD (prefiks __RENT_TEST__), także przy błędzie.
 */
import { Hono } from "hono";
import { db, schema } from "../src/db/index.js";
import { inArray, like } from "drizzle-orm";
import analyticsApp from "../src/routes/analytics.js";
import objectsApp from "../src/routes/objects.js";
import { clearPersonnelCostCache } from "../src/lib/object-personnel-cost.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(
    `${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`
  );
  if (!cond) failures++;
}

const PREFIX = "__RENT_TEST__";

const app = new Hono();
app.route("/analytics", analyticsApp);
app.route("/objects", objectsApp);

type Res = { status: number; success?: boolean; data?: any; error?: string };
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

function cleanup() {
  const objs = db
    .select()
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all();
  const ids = objs.map((o) => o.id);
  if (ids.length) {
    db.delete(schema.objectHistory)
      .where(inArray(schema.objectHistory.objectId, ids))
      .run();
    db.delete(schema.objects).where(inArray(schema.objects.id, ids)).run();
  }
  db.delete(schema.contractors)
    .where(like(schema.contractors.name, `${PREFIX}%`))
    .run();
  clearPersonnelCostCache();
}

try {
  cleanup();

  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX} Klient`, nip: "0000000000" })
    .returning()
    .all()[0];

  // Obiekt A: abonament 200 + dzierżawa 400, koszt 100 → przychód 600, zysk 500.
  const withRental = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Z dzierżawą`,
      type: "monitoring",
      installationType: "new",
      status: "active",
      monthlyValue: 200,
      monthlyRental: 400,
      monthlyCost: 100,
    })
    .returning()
    .all()[0];

  // Obiekt B: sam abonament — musi zachować się dokładnie jak przed zmianą.
  const noRental = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Bez dzierżawy`,
      type: "monitoring",
      installationType: "new",
      status: "active",
      monthlyValue: 300,
      monthlyCost: 100,
    })
    .returning()
    .all()[0];

  // Obiekt C: SAMA dzierżawa, bez abonamentu — nie może wyglądać na bezprzychodowy.
  const onlyRental = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Sama dzierżawa`,
      type: "monitoring",
      installationType: "new",
      status: "active",
      monthlyRental: 250,
    })
    .returning()
    .all()[0];

  clearPersonnelCostCache();

  // --- Analityka ------------------------------------------------------------
  const analytics = await call("GET", "/analytics/obiekty?scope=all");
  ok("analityka odpowiada", analytics.status === 200, analytics.error);
  const rows: any[] = analytics.data?.rows ?? analytics.data?.objects ?? analytics.data ?? [];
  const rowA = rows.find((r) => r.id === withRental.id);
  const rowB = rows.find((r) => r.id === noRental.id);
  const rowC = rows.find((r) => r.id === onlyRental.id);

  ok("obiekt z dzierżawą jest w wyniku", !!rowA, rows.length);
  ok("przychód = abonament + dzierżawa (200 + 400)", rowA?.revenue === 600, rowA);
  ok("zysk liczony z pełnego przychodu (600 − 100)", rowA?.profit === 500, rowA);
  ok("obiekt bez dzierżawy bez zmian (300)", rowB?.revenue === 300, rowB);
  ok("sama dzierżawa też jest przychodem (250)", rowC?.revenue === 250, rowC);

  // --- Lista obiektów: sortowanie, filtry, podsumowanie ---------------------
  const list = await call(
    "GET",
    `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&limit=50`
  );
  ok("lista obiektów odpowiada", list.status === 200, list.error);
  // Podsumowanie leci płasko w odpowiedzi listy, obok `total`/`page`.
  const listAny = list as any;
  ok(
    "suma przychodu w podsumowaniu obejmuje dzierżawę (600+300+250)",
    listAny.totalMonthlyValue === 1150,
    listAny.totalMonthlyValue
  );
  ok(
    "licznik „ma przychód” liczy też obiekt z samą dzierżawą",
    listAny.withMonthlyValue === 3,
    listAny.withMonthlyValue
  );

  const filtered = await call(
    "GET",
    `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&hasValue=1&limit=50`
  );
  const filteredIds: number[] = (filtered.data ?? []).map((o: any) => o.id);
  ok(
    "filtr „ma przychód” łapie obiekt z samą dzierżawą",
    filteredIds.includes(onlyRental.id),
    filteredIds
  );

  const minFiltered = await call(
    "GET",
    `/objects?search=${encodeURIComponent(PREFIX)}&scope=all&minValue=500&limit=50`
  );
  const minIds: number[] = (minFiltered.data ?? []).map((o: any) => o.id);
  ok(
    "widełki od 500 zł łapią obiekt 200+400, a nie łapią 300",
    minIds.includes(withRental.id) && !minIds.includes(noRental.id),
    minIds
  );

  // --- Zapis przez API ------------------------------------------------------
  const updated = await call("PUT", `/objects/${noRental.id}`, {
    monthlyRental: 50,
  });
  ok("PUT zapisuje dzierżawę", updated.status === 200, updated);
  const afterUpdate = db
    .select()
    .from(schema.objects)
    .where(inArray(schema.objects.id, [noRental.id]))
    .all()[0];
  ok("dzierżawa w bazie po zapisie", afterUpdate?.monthlyRental === 50, afterUpdate);
} finally {
  cleanup();

  const left = db
    .select()
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych obiektów", left.length === 0, left);
  const leftC = db
    .select()
    .from(schema.contractors)
    .where(like(schema.contractors.name, `${PREFIX}%`))
    .all();
  ok("sprzątanie: brak testowych kontrahentów", leftC.length === 0, leftC);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
