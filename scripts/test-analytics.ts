/**
 * Test arytmetyki Analityki (src/routes/analytics.ts) na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-analytics.ts
 * Zakłada fikstury z prefiksem __ZZ_ANALYTICS__ (handlowcy, kontrahenci, obiekty, kadry)
 * i sprawdza: regułę efektywnego handlowca (własny vs odziedziczony vs brak), rozróżnienie
 * koszt NULL („nieuzupełniony”) od kosztu 0 zł, prowizję + koszt własny handlowca, okres
 * zwrotu, zakresy current/active/all, to, że PODSUMOWANIA nie zależą od `limit`, oraz
 * KOSZT OSOBOWY z Kadr: że dokłada się do kosztu pozostałego (a nie go zastępuje), że
 * godziny na pozycjach niezmapowanych zostają kosztem ogólnym, że trzy okna uśredniania
 * dają przewidywalnie różne kwoty i że handlowiec powiązany z kartoteką kadrową ma koszt
 * własny z wypłat, a nie z pola ręcznego.
 * Sprząta po sobie HARD (kadry + obiekty + kontrahenci + handlowcy + object_history),
 * także przy błędzie.
 *
 * Nie ma tu frameworka testowego — to konwencja z pozostałych scripts/test-*.ts.
 */
import { db, schema } from "../src/db/index.js";
import { eq, inArray, like } from "drizzle-orm";
import analyticsApp from "../src/routes/analytics.js";
import {
  clearPersonnelCostCache,
  fullMonths,
} from "../src/lib/object-personnel-cost.js";

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

/**
 * Hard delete fikstur. Kolejność wymuszona kluczami obcymi: godziny i wypłaty przed
 * umowami, umowy przed pracownikami; obiekty przed kontrahentami; handlowcy na końcu,
 * bo dopiero po skasowaniu pracownika przestaje ich cokolwiek trzymać.
 */
function cleanup() {
  const empIds = db
    .select({ id: schema.hrEmployees.id })
    .from(schema.hrEmployees)
    .where(like(schema.hrEmployees.fullName, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (empIds.length) {
    const contractIds = db
      .select({ id: schema.hrContracts.id })
      .from(schema.hrContracts)
      .where(inArray(schema.hrContracts.employeeId, empIds))
      .all()
      .map((r) => r.id);
    if (contractIds.length) {
      db.delete(schema.hrPayroll).where(inArray(schema.hrPayroll.contractId, contractIds)).run();
      db.delete(schema.hrContracts).where(inArray(schema.hrContracts.id, contractIds)).run();
    }
    db.delete(schema.hrHours).where(inArray(schema.hrHours.employeeId, empIds)).run();
    db.delete(schema.hrOfficePayroll).where(inArray(schema.hrOfficePayroll.employeeId, empIds)).run();
    // Powiązania z kadr trzeba zdjąć ręcznie: FK jest ON DELETE SET NULL, ale handlowca
    // i tak kasujemy niżej — chodzi o to, żeby nie zostawić wiszącego wskazania,
    // gdyby kasowanie handlowca się nie powiodło.
    db.update(schema.salespeople).set({ employeeId: null })
      .where(inArray(schema.salespeople.employeeId, empIds)).run();
    db.delete(schema.hrEmployees).where(inArray(schema.hrEmployees.id, empIds)).run();
  }
  db.delete(schema.hrObjects).where(like(schema.hrObjects.name, `${PREFIX}%`)).run();

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
  // Cache kosztu osobowego trzyma wynik dla stanu danych sprzed sprzątania.
  clearPersonnelCostCache();
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

  /* --- Fikstury kosztu OSOBOWEGO (Kadry → obiekt) --------------------------
   * Osobny kontrahent, osobny obiekt i osobny handlowiec — celowo NIE dokładamy
   * kosztu osobowego do O1..O7, żeby asercje o koszcie „pozostałym" powyżej dalej
   * mówiły dokładnie to, co mówiły.
   *
   * Konstrukcja jest tak dobrana, żeby wynik dało się policzyć w głowie:
   *   pracownik ma JEDNĄ umowę i JEDNĄ wypłatę 3 000 zł w ostatnim pełnym miesiącu,
   *   100 h na pozycji ZMAPOWANEJ na O8 i 100 h na pozycji NIEZMAPOWANEJ,
   *   czyli na obiekt idzie połowa jego kosztu: 1 500 zł w tym miesiącu.
   * Średnia z N miesięcy = 1 500 / N, bo w pozostałych miesiącach okna ten pracownik
   * nie ma ani godzin, ani wypłaty. Ile miesięcy weszło — mówi `totals.personnel.monthsUsed`
   * (zależy od tego, za ile miesięcy w bazie są w ogóle dane płacowe).
   */
  const [emp] = db
    .insert(schema.hrEmployees)
    .values({ fullName: `${PREFIX}Pracownik`, kind: "ochrona", active: true })
    .returning()
    .all();

  // Handlowiec C jest TĄ SAMĄ osobą co pracownik — `monthlyCost` 9 999 zł musi zostać
  // zignorowany na rzecz kwoty z wypłat, inaczej firma płaciłaby za niego dwa razy.
  const [spC] = db
    .insert(schema.salespeople)
    .values({
      firstName: "Cezary",
      lastName: `${PREFIX}C`,
      monthlyCost: 9999,
      employeeId: emp.id,
    })
    .returning()
    .all();

  const [c4] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent4`, nip: `${PREFIX}4`, salespersonId: spC.id })
    .returning()
    .all();
  // O8: 10 000 przychodu, 2 000 kosztu POZOSTAŁEGO (monitoring itd.) + koszt osobowy z kadr.
  const o8 = obj({
    name: `${PREFIX}O8`,
    contractorId: c4.id,
    monthlyValue: 10000,
    monthlyCost: 2000,
  });

  // Pozycja słownika kadrowego zmapowana na O8 i druga, celowo NIEZMAPOWANA
  // (odpowiednik CMA / #BIURO) — jej godziny mają zostać kosztem ogólnym.
  const [hroMapped] = db
    .insert(schema.hrObjects)
    .values({ name: `${PREFIX}POSTERUNEK`, objectId: o8.id })
    .returning()
    .all();
  const [hroUnmapped] = db
    .insert(schema.hrObjects)
    .values({ name: `${PREFIX}CENTRALA`, objectId: null })
    .returning()
    .all();

  const [contract] = db
    .insert(schema.hrContracts)
    .values({
      employeeId: emp.id,
      company: "ALFA",
      contractType: "zlecenie",
      zua: "tak", // niepuste ZUA = umowa główna; bez tego godziny są nierozliczane
      mainChannel: "przelew",
      bonusType: "brak", // bez dodatku wypłata = sama kwota główna, czyli 3 000 zł
      active: true,
    })
    .returning()
    .all();

  // Ostatni pełny miesiąc — ten sam, który wybiera moduł kosztu osobowego.
  const [m1] = fullMonths(1);
  db.insert(schema.hrPayroll)
    .values({ contractId: contract.id, year: m1.year, month: m1.month, mainAmount: 3000 })
    .run();
  db.insert(schema.hrHours)
    .values([
      { employeeId: emp.id, objectId: hroMapped.id, year: m1.year, month: m1.month, workedHours: 100 },
      { employeeId: emp.id, objectId: hroUnmapped.id, year: m1.year, month: m1.month, workedHours: 100 },
    ])
    .run();
  clearPersonnelCostCache();

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

  // --- Koszt osobowy z Kadr ----------------------------------------------
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const p1 = await call("/obiekty?scope=current&costWindow=1");
  const p3 = await call("/obiekty?scope=current&costWindow=3");
  const p12 = await call("/obiekty?scope=current&costWindow=12");
  const o8of = (d: any) => d.rows.find((r: any) => r.name === `${PREFIX}O8`);

  ok("costWindow wraca w odpowiedzi obok scope",
    p1.costWindow === 1 && p3.costWindow === 3 && p12.costWindow === 12,
    { p1: p1.costWindow, p3: p3.costWindow, p12: p12.costWindow });
  ok("domyślne okno to średnia z 3 miesięcy", os.costWindow === 3, os.costWindow);
  ok("okno 1 = dokładnie jeden pełny miesiąc", p1.totals.personnel.monthsUsed === 1,
    p1.totals.personnel);

  // (a) koszty SIĘ SKŁADAJĄ
  ok("O8: koszt osobowy = 1 500 (połowa wypłaty 3 000 zł)",
    near(o8of(p1)?.personnelCost, 1500), o8of(p1));
  ok("O8: koszt pozostały nietknięty = 2 000 (monthly_cost)",
    o8of(p1)?.otherCost === 2000, o8of(p1));
  ok("O8: koszt całkowity = osobowy + pozostały = 3 500, a NIE jedno zamiast drugiego",
    near(o8of(p1)?.cost, 3500), o8of(p1));
  ok("O8: zysk liczony od sumy kosztów = 10 000 − 3 500", near(o8of(p1)?.profit, 6500), o8of(p1));
  ok("O8: marża od kosztu całkowitego = 65%", near(o8of(p1)?.margin, 65), o8of(p1));

  // (b) godziny na pozycji NIEZMAPOWANEJ zostają kosztem ogólnym
  ok("Połowa wypłaty (godziny na niezmapowanej pozycji) NIE trafia na obiekt",
    near(o8of(p1)?.personnelCost, 1500) && !near(o8of(p1)?.personnelCost, 3000), o8of(p1));
  db.update(schema.hrObjects).set({ objectId: o8.id }).where(eq(schema.hrObjects.id, hroUnmapped.id)).run();
  clearPersonnelCostCache();
  const bothMapped = await call("/obiekty?scope=current&costWindow=1");
  ok("Po zmapowaniu drugiej pozycji na TEN SAM obiekt koszty się sumują → 3 000",
    near(o8of(bothMapped)?.personnelCost, 3000), o8of(bothMapped));
  db.update(schema.hrObjects).set({ objectId: null }).where(eq(schema.hrObjects.id, hroUnmapped.id)).run();
  clearPersonnelCostCache();

  // (c) trzy okna uśredniania — ta sama kwota rozłożona na coraz więcej miesięcy
  const m3 = p3.totals.personnel.monthsUsed;
  const m12 = p12.totals.personnel.monthsUsed;
  ok("Dłuższe okno bierze więcej miesięcy (1 < 3 ≤ 12)", 1 < m3 && m3 <= m12, { m3, m12 });
  ok(`O8: średnia z 3 mies. = 1 500 / ${m3}`,
    near(o8of(p3)?.personnelCost, round2(1500 / m3)), o8of(p3));
  ok(`O8: średnia z 12 mies. = 1 500 / ${m12}`,
    near(o8of(p12)?.personnelCost, round2(1500 / m12)), o8of(p12));
  ok("Trzy okna dają trzy różne kwoty (malejące wraz z długością okna)",
    o8of(p1).personnelCost > o8of(p3).personnelCost &&
      (m3 === m12 || o8of(p3).personnelCost > o8of(p12).personnelCost),
    { w1: o8of(p1).personnelCost, w3: o8of(p3).personnelCost, w12: o8of(p12).personnelCost });
  ok("months[] wylistowane w komplecie i domknięte ostatnim pełnym miesiącem",
    p3.totals.personnel.months.length === m3 &&
      p3.totals.personnel.months.at(-1).year === fullMonths(1)[0].year &&
      p3.totals.personnel.months.at(-1).month === fullMonths(1)[0].month,
    p3.totals.personnel.months);

  // Koszt z kadr sam w sobie wystarcza, żeby koszt obiektu był ZNANY.
  db.update(schema.objects).set({ monthlyCost: null }).where(eq(schema.objects.id, o8.id)).run();
  const noManual = await call("/obiekty?scope=current&costWindow=1");
  ok("monthly_cost NULL, ale kadry dały koszt → hasCost true",
    o8of(noManual)?.hasCost === true, o8of(noManual));
  ok("...i marża jest wtedy ZNANA (85% od kosztu 1 500)",
    near(o8of(noManual)?.margin, 85), o8of(noManual));
  db.update(schema.objects).set({ monthlyCost: 2000 }).where(eq(schema.objects.id, o8.id)).run();

  // Stan wyjściowy bazy: mapowania nie ma jeszcze wcale. Nic nie może się wysypać.
  db.update(schema.hrObjects).set({ objectId: null }).where(eq(schema.hrObjects.id, hroMapped.id)).run();
  clearPersonnelCostCache();
  const nomap = await call("/obiekty?scope=current&costWindow=3");
  ok("Bez mapowania: koszt osobowy obiektu = 0, koszt = sam monthly_cost",
    o8of(nomap)?.personnelCost === 0 && near(o8of(nomap)?.cost, 2000), o8of(nomap));
  ok("Bez mapowania: hasCost wraca do reguły monthly_cost IS NOT NULL",
    o8of(nomap)?.hasCost === true, o8of(nomap));
  db.update(schema.hrObjects).set({ objectId: o8.id }).where(eq(schema.hrObjects.id, hroMapped.id)).run();
  clearPersonnelCostCache();

  // --- Kontrahent: rozbicie kosztu ---------------------------------------
  const ks1 = await call("/kontrahenci?scope=current&costWindow=1");
  const k4 = ks1.rows.find((r: any) => r.name === `${PREFIX}Kontrahent4`);
  ok("K4: rolka kontrahenta niesie rozbicie osobowy/pozostały i ich sumę",
    near(k4?.personnelCost, 1500) && near(k4?.otherCost, 2000) && near(k4?.cost, 3500), k4);
  ok("K4: zysk kontrahenta liczony od kosztu całkowitego", near(k4?.profit, 6500), k4);

  // --- Handlowiec powiązany z kadrami ------------------------------------
  const hs1 = await call("/handlowcy?scope=current&costWindow=1");
  const rowC = hs1.rows.find((r: any) => r.lastName === `${PREFIX}C`);
  const rowA1 = hs1.rows.find((r: any) => r.lastName === `${PREFIX}A`);
  ok("C: koszt własny z KADR (3 000), a nie 9 999 z pola ręcznego",
    near(rowC?.ownCost, 3000), rowC);
  ok("C: ownCostSource = kadry", rowC?.ownCostSource === "kadry", rowC);
  ok("C: pole ręczne wraca osobno, żeby front mógł je pokazać zablokowane",
    rowC?.manualMonthlyCost === 9999, rowC);
  ok("A: bez powiązania z kadrami koszt własny nadal z pola ręcznego",
    rowA1?.ownCostSource === "reczny" && rowA1?.ownCost === 5000, rowA1);
  ok("C: koszt portfela = osobowy 1 500 + pozostały 2 000",
    near(rowC?.objectsCost, 3500) &&
      near(rowC?.objectsPersonnelCost, 1500) &&
      near(rowC?.objectsOtherCost, 2000), rowC);
  ok("C: zysk = 10 000 − 3 500 − 3 000 (bez prowizji) = 3 500", near(rowC?.profit, 3500), rowC);

  const hs3 = await call("/handlowcy?scope=current&costWindow=3");
  const rowC3 = hs3.rows.find((r: any) => r.lastName === `${PREFIX}C`);
  ok(`C: koszt własny też się uśrednia — 3 000 / ${m3}`,
    near(rowC3?.ownCost, round2(3000 / m3)), rowC3);

  // --- Blok informacyjny w totals ----------------------------------------
  const info = p1.totals.personnel;
  ok("totals: koszt całkowity = osobowy + pozostały",
    near(p1.totals.cost, p1.totals.personnelCost + p1.totals.otherCost), p1.totals);
  ok("totals: przypis o wyliczeniu kompletny (okno, miesiące, mapowanie, godziny ogólne)",
    info.costWindow === 1 &&
      info.monthsUsed === 1 &&
      info.mappedObjects >= 1 &&
      info.hrObjectsTotal >= info.mappedObjects &&
      info.unmappedHoursShare > 0 &&
      info.unmappedHoursShare <= 1,
    info);
  ok("totals: kwoty oznaczone jako NETTO (bez kosztu pracodawcy)", info.net === true, info);
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
