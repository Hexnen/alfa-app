/**
 * Test arytmetyki Analityki (src/routes/analytics.ts) na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-analytics.ts
 * Zakłada fikstury z prefiksem __ZZ_ANALYTICS__ (handlowcy, kontrahenci, obiekty) i sprawdza:
 * regułę efektywnego handlowca (własny vs odziedziczony vs brak), rozróżnienie koszt NULL
 * („nieuzupełniony”) od kosztu 0 zł, prowizję + koszt własny handlowca, okres zwrotu,
 * zakresy current/active/all oraz to, że PODSUMOWANIA nie zależą od `limit`.
 * Sprząta po sobie HARD (obiekty + kontrahenci + handlowcy + object_history), także przy błędzie.
 *
 * Nie ma tu frameworka testowego — to konwencja z pozostałych scripts/test-*.ts.
 */
import { db, schema } from "../src/db/index.js";
import { eq, inArray, like } from "drizzle-orm";
import analyticsApp from "../src/routes/analytics.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
/** Porównanie kwot z tolerancją — w grze są ułamki z procentów. */
function near(a: number | null, b: number, eps = 0.001) {
  return a !== null && Math.abs(a - b) < eps;
}

const PREFIX = "__ZZ_ANALYTICS__";

/** Hard delete fikstur (obiekty przed kontrahentami, handlowcy na końcu). */
function cleanup() {
  const objIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (objIds.length) {
    db.delete(schema.objectHistory).where(inArray(schema.objectHistory.objectId, objIds)).run();
    db.delete(schema.objects).where(inArray(schema.objects.id, objIds)).run();
  }
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  db.delete(schema.salespeople).where(like(schema.salespeople.lastName, `${PREFIX}%`)).run();
}

async function call(path: string) {
  const res = await analyticsApp.request(path);
  const body = (await res.json()) as { success: boolean; data: any };
  if (!body.success) throw new Error(`${path} → ${JSON.stringify(body)}`);
  return body.data;
}

async function main() {
  cleanup();

  // --- Fikstury -----------------------------------------------------------
  // Handlowiec A: ma koszt własny i prowizję — na nim liczymy pełną formułę.
  const [spA] = db
    .insert(schema.salespeople)
    .values({ firstName: "Ala", lastName: `${PREFIX}A`, monthlyCost: 5000, commissionRate: 10 })
    .returning()
    .all();
  // Handlowiec B: bez kosztu i prowizji — sprawdza, że null nie psuje arytmetyki.
  const [spB] = db
    .insert(schema.salespeople)
    .values({ firstName: "Bo", lastName: `${PREFIX}B` })
    .returning()
    .all();

  // Kontrahent 1 ma opiekuna B — jego obiekty bez własnego handlowca dziedziczą B.
  const [c1] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent1`, nip: `${PREFIX}1`, salespersonId: spB.id })
    .returning()
    .all();
  // Kontrahent 2 nie ma opiekuna — jego obiekt ląduje w kubełku „Bez handlowca”.
  const [c2] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent2`, nip: `${PREFIX}2` })
    .returning()
    .all();

  const obj = (v: Partial<typeof schema.objects.$inferInsert>) =>
    db
      .insert(schema.objects)
      .values({
        contractorId: c1.id,
        name: `${PREFIX}o`,
        type: "monitoring",
        installationType: "new",
        status: "active",
        ...v,
      })
      .returning()
      .all()[0];

  // O1 — własny handlowiec A (nadpisuje opiekuna kontrahenta): 20 000 przychodu, 8 000 kosztu.
  obj({ name: `${PREFIX}O1`, monthlyValue: 20000, monthlyCost: 8000, salespersonId: spA.id });
  // O2 — koszt NULL („nieuzupełniony”). O3 — koszt 0 zł (uzupełniony fakt). Oba dziedziczą B.
  obj({ name: `${PREFIX}O2`, monthlyValue: 1000, monthlyCost: null });
  obj({ name: `${PREFIX}O3`, monthlyValue: 1000, monthlyCost: 0 });
  // O4 — zwrot z instalacji: 12 000 / (2 000 − 1 000) = 12 miesięcy.
  obj({ name: `${PREFIX}O4`, monthlyValue: 2000, monthlyCost: 1000, setupCost: 12000 });
  // O5 — archiwalny: widoczny tylko w scope=all.
  obj({ name: `${PREFIX}O5`, monthlyValue: 999, monthlyCost: 1, status: "inactive" });
  // O6 — kontrahent bez opiekuna → „Bez handlowca”.
  obj({ name: `${PREFIX}O6`, contractorId: c2.id, monthlyValue: 700, monthlyCost: 200 });

  // Kontrahent 3 — ŻADEN jego obiekt nie ma kosztu. To stan „dnia pierwszego”:
  // zysk równa się przychodowi tylko dlatego, że koszty policzyliśmy jako zero,
  // więc marża musi być nieznana (null), a nie 100%.
  const [c3] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent3`, nip: `${PREFIX}3`, salespersonId: null })
    .returning()
    .all();
  obj({ name: `${PREFIX}O7`, contractorId: c3.id, monthlyValue: 3000, monthlyCost: null });

  // --- Handlowcy ----------------------------------------------------------
  const hs = await call("/handlowcy?scope=current");
  const rowA = hs.rows.find((r: any) => r.lastName === `${PREFIX}A`);
  const rowB = hs.rows.find((r: any) => r.lastName === `${PREFIX}B`);

  ok("A: przychód portfela = 20 000 (tylko własny obiekt)", rowA?.revenue === 20000, rowA);
  ok("A: koszt obiektów = 8 000", rowA?.objectsCost === 8000, rowA);
  ok("A: koszt własny = 5 000", rowA?.ownCost === 5000, rowA);
  ok("A: prowizja 10% = 2 000", near(rowA?.commission, 2000), rowA);
  ok("A: marża portfela przed kosztem handlowca = 12 000", near(rowA?.contribution, 12000), rowA);
  ok("A: zysk = 20 000 − 8 000 − 5 000 − 2 000 = 5 000", near(rowA?.profit, 5000), rowA);
  ok("A: marża = 25%", near(rowA?.margin, 25), rowA);
  ok("A: ROI = 20 000 / 7 000", near(rowA?.roi, 20000 / 7000), rowA);

  // B dziedziczy O2 (koszt NULL), O3 (koszt 0) i O4 — O5 jest archiwalny, O1 ma własnego handlowca.
  ok("B: 3 obiekty odziedziczone po kontrahencie", rowB?.objectsCount === 3, rowB);
  ok("B: koszt NULL ≠ 0 — uzupełnione tylko 2 z 3", rowB?.objectsWithCost === 2, rowB);
  ok("B: bez kosztu własnego i prowizji zysk = przychód − koszt obiektów",
    near(rowB?.profit, 4000 - 1000), rowB);

  ok("Bez handlowca: 1 obiekt kontrahenta bez opiekuna", hs.unassigned.objectsCount >= 1, hs.unassigned);

  const sumRows = hs.rows.reduce((s: number, r: any) => s + r.revenue, 0);
  ok("Suma przychodów handlowców + bez handlowca = przychód firmy",
    near(sumRows + hs.unassigned.revenue, hs.totals.revenue),
    { sumRows, unassigned: hs.unassigned.revenue, totals: hs.totals.revenue });

  // --- Obiekty ------------------------------------------------------------
  const os = await call("/obiekty?scope=current");
  const byName = (n: string) => os.rows.find((r: any) => r.name === `${PREFIX}${n}`);

  ok("O4: zwrot z instalacji = 12 mies.", byName("O4")?.payback === 12, byName("O4"));
  ok("O1: brak nakładu → payback null", byName("O1")?.payback === null, byName("O1"));
  ok("O2: koszt NULL → hasCost false", byName("O2")?.hasCost === false, byName("O2"));
  ok("O2: koszt nieznany → marża null, a NIE 100%", byName("O2")?.margin === null, byName("O2"));
  ok("O3: koszt 0 zł → hasCost true i marża 100%",
    byName("O3")?.hasCost === true && near(byName("O3")?.margin, 100), byName("O3"));
  ok("O2 (koszt nieznany) trafia do kubełka „brak danych”, nie do 60%+",
    (os.marginBuckets.find((b: any) => b.key === "brak danych")?.count ?? 0) >= 1,
    os.marginBuckets);
  ok("marginBuckets ma zawsze 6 stałych pozycji", os.marginBuckets.length === 6, os.marginBuckets);
  ok("O1: własny handlowiec nie jest odziedziczony",
    byName("O1")?.salesperson?.inherited === false, byName("O1")?.salesperson);
  ok("O2: handlowiec odziedziczony po kontrahencie",
    byName("O2")?.salesperson?.inherited === true, byName("O2")?.salesperson);
  ok("O6: kontrahent bez opiekuna → brak handlowca",
    byName("O6")?.salesperson === null, byName("O6")?.salesperson);

  // --- Zakres -------------------------------------------------------------
  const osAll = await call("/obiekty?scope=all");
  ok("scope=current pomija archiwalny O5", byName("O5") === undefined);
  ok("scope=all pokazuje archiwalny O5",
    osAll.rows.some((r: any) => r.name === `${PREFIX}O5`));
  ok("scope=all ma więcej obiektów niż current", osAll.totals.objects > os.totals.objects,
    { all: osAll.totals.objects, current: os.totals.objects });

  // --- Podsumowania nie zależą od limitu ----------------------------------
  const limited = await call("/obiekty?scope=current&limit=1");
  ok("limit=1 tnie wiersze", limited.rows.length === 1, limited.rows.length);
  ok("limit=1 NIE zmienia przychodu w podsumowaniu",
    near(limited.totals.revenue, os.totals.revenue),
    { limited: limited.totals.revenue, full: os.totals.revenue });
  ok("limit=1 NIE zmienia pokrycia kosztami",
    near(limited.totals.coverage, os.totals.coverage),
    { limited: limited.totals.coverage, full: os.totals.coverage });

  // --- Kontrahenci --------------------------------------------------------
  const ks = await call("/kontrahenci?scope=current");
  const k1 = ks.rows.find((r: any) => r.name === `${PREFIX}Kontrahent1`);
  ok("K1: 4 bieżące obiekty (O5 archiwalny poza zakresem)", k1?.objectsCount === 4, k1);
  ok("K1: przychód = 24 000", k1?.revenue === 24000, k1);
  ok("K1: koszt = 9 000 (NULL liczony jak 0)", k1?.cost === 9000, k1);
  ok("K1: zysk = 15 000", near(k1?.profit, 15000), k1);
  ok("K1: koszt uzupełniony na 3 z 4 obiektów", k1?.objectsWithCost === 3, k1);

  // Dzień pierwszy: bez ani jednego znanego kosztu marża jest NIEZNANA.
  const k3 = ks.rows.find((r: any) => r.name === `${PREFIX}Kontrahent3`);
  ok("K3: zero znanych kosztów → marża null, a NIE 100%", k3?.margin === null, k3);
  ok("K3: przychód nadal policzony (wykresy przychodu mają działać)", k3?.revenue === 3000, k3);
  ok("K3: pokrycie kosztami = 0", k3?.objectsWithCost === 0, k3);

  ok("Zgodność sum: przychód firmy taki sam w obu widokach",
    near(ks.totals.revenue, os.totals.revenue),
    { kontrahenci: ks.totals.revenue, obiekty: os.totals.revenue });
  ok("Zgodność sum: przychód firmy taki sam u handlowców",
    near(hs.totals.revenue, os.totals.revenue),
    { handlowcy: hs.totals.revenue, obiekty: os.totals.revenue });
}

try {
  await main();
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  cleanup();
  console.log(failures === 0 ? "\nWszystko OK" : `\n${failures} nieudanych asercji`);
  process.exit(failures === 0 ? 0 : 1);
}
