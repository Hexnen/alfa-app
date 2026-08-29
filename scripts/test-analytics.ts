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
 * Osobna sekcja pilnuje DRUGIEJ ŚCIEŻKI kosztu osobowego — udziału w koszcie centrum
 * monitorowania: wagi usług (kamera po sztuce, SSWiN i wideorecepcja po jednym), tego
 * że archiwalny obiekt nie rozcieńcza mianownika, że brak liczby kamer jest zgłaszany
 * zamiast po cichu zaniżać koszt, że obie ścieżki się SUMUJĄ i że bez pozycji-puli
 * mechanizm jest po prostu nieaktywny, a nie zepsuty.
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
import { COMPANY_FIELDS } from "../src/lib/company-config.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

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

/* --- Narzuty składek pracodawcy ------------------------------------------
 * Test podmienia GLOBALNE ustawienia narzutów w app_settings, więc musi je
 * przywrócić co do wpisu: „było 1,59" i „nie było wpisu wcale" (czyli wartość
 * domyślna z kodu) to dwa różne stany i mylenie ich zostawiłoby po teście
 * zaśmiecone ustawienia firmy.
 */
const MARKUP_FIELDS = [
  "employerMarkupUop",
  "employerMarkupZlecenieZua",
  "employerMarkupZlecenieZza",
  "employerMarkupOfficeDefault",
] as const;
type MarkupField = (typeof MARKUP_FIELDS)[number];

const markupKey = (f: MarkupField) => COMPANY_FIELDS[f].dbKey;

/** Stan wpisów sprzed testu: klucz → wartość albo null („wpisu nie było"). */
const savedMarkups = new Map<string, string | null>();

function stashMarkups() {
  for (const f of MARKUP_FIELDS) {
    const key = markupKey(f);
    if (!savedMarkups.has(key)) savedMarkups.set(key, getSetting(key));
  }
}

function setMarkup(f: MarkupField, value: number) {
  stashMarkups();
  setSetting(markupKey(f), String(value), null);
}

function restoreMarkups() {
  for (const [key, value] of savedMarkups) {
    if (value === null) deleteSetting(key);
    else setSetting(key, value, null);
  }
  savedMarkups.clear();
}

/**
 * Narzuty na czas testu — celowo okrągłe i różne od domyślnych (1,65 / 1,59 / 1,22 / 1,65),
 * żeby każdą kwotę dało się sprawdzić w głowie i żeby przypadkowa równość dwóch
 * współczynników nie przepuściła błędu „wszystko liczone tym samym narzutem".
 */
const MK = { uop: 2, zlecenieZua: 1.5, zlecenieZza: 1.2, officeDefault: 1.8 };

/**
 * Pozycje kadrowe, którym test CHWILOWO zdjął `is_cma_pool` (żeby sprawdzić, że bez
 * puli nic się nie sypie). Trzymamy ich id poza `main()`, bo gdyby test wywalił się
 * w środku tej sekcji, produkcyjna pozycja „CMA" zostałaby wyłączona — a wtedy cała
 * firma po cichu przestałaby rozdzielać koszt centrum.
 */
const disabledPools: number[] = [];

function restoreCmaPools() {
  if (!disabledPools.length) return;
  db.update(schema.hrObjects)
    .set({ isCmaPool: true })
    .where(inArray(schema.hrObjects.id, disabledPools))
    .run();
  disabledPools.length = 0;
}

/**
 * Hard delete fikstur. Kolejność wymuszona kluczami obcymi: godziny i wypłaty przed
 * umowami, umowy przed pracownikami; obiekty przed kontrahentami; handlowcy na końcu,
 * bo dopiero po skasowaniu pracownika przestaje ich cokolwiek trzymać.
 */
function cleanup() {
  // NAJPIERW przywrócenie pul — kasowanie fikstur nie może zostawić wyłączonej
  // produkcyjnej pozycji CMA.
  restoreCmaPools();
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
  // Fikstura spółki — nośnik nadpisań narzutu per spółka.
  db.delete(schema.companies).where(like(schema.companies.name, `${PREFIX}%`)).run();
  // Ustawienia narzutów wracają do stanu sprzed testu (patrz `restoreMarkups`).
  restoreMarkups();
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

  /*
   * Cała arytmetyka alokacji (sekcje niżej) liczy się przy narzutach składkowych
   * USTAWIONYCH NA 1, czyli koszt pracodawcy = wypłata netto. Dzięki temu asercje
   * o kosztach obiektów mówią o rozdziale godzin, a nie o składkach — a składki
   * dostają własną sekcję na końcu, gdzie narzuty są jawnie różne.
   */
  for (const f of MARKUP_FIELDS) setMarkup(f, 1);
  clearPersonnelCostCache();

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

  // Własna spółka fikstury — narzuty per spółka testujemy na NIEJ, żeby nie ruszać
  // nadpisań prawdziwych spółek grupy. Dopasowanie umowa→spółka idzie po NAZWIE.
  const [comp] = db
    .insert(schema.companies)
    .values({ name: `${PREFIX}SPOLKA` })
    .returning()
    .all();

  const [contract] = db
    .insert(schema.hrContracts)
    .values({
      employeeId: emp.id,
      company: comp.name,
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

  /* --- Fikstury DRUGIEJ ŚCIEŻKI: udział w koszcie centrum monitorowania ----
   * Osobny kontrahent, żeby liczniki obiektów K1..K4 wyżej dalej się zgadzały,
   * i osobni pracownicy, żeby nie ruszyć podziału godzin pracownika z O8.
   *
   * Kwot puli NIE zakładamy z góry: w prawdziwej bazie jest już pozycja „CMA"
   * z własnymi dyżurnymi, więc asercje sprawdzają RELACJE (obiekt z 4 kamerami
   * dostaje dwa razy tyle, co obiekt z 2) i zgodność z `cma.perUnit` z API,
   * a nie wymyśloną kwotę. Fikstura dokłada do puli własne 3 600 zł tylko po to,
   * żeby pula była niezerowa nawet na pustej bazie.
   */
  const [c5] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent5`, nip: `${PREFIX}5` })
    .returning()
    .all();
  const cmaObj = (name: string, v: Partial<typeof schema.objects.$inferInsert>) =>
    obj({ name: `${PREFIX}${name}`, contractorId: c5.id, monthlyValue: 0, ...v });

  const oCam4 = cmaObj("CAM4", { hasCameras: true, cameraCount: 4 }); // 4 jednostki
  const oCam2 = cmaObj("CAM2", { hasCameras: true, cameraCount: 2 }); // 2 jednostki
  const oSswin = cmaObj("SSWIN", { hasSswin: true }); // 1 jednostka
  const oVideo = cmaObj("WIDEO", { hasVideoreception: true }); // 1 jednostka
  // Archiwalny — ma usługi, ale centrum go już nie dozoruje: 5 jednostek, które
  // NIE mogą rozcieńczać kosztu obiektom, które wciąż są na monitoringu.
  const oArch = cmaObj("ARCH", { hasCameras: true, cameraCount: 5, status: "inactive" });
  // Kamery BEZ podanej liczby — waga tylko z SSWiN-u, a brak liczby zgłoszony osobno.
  const oNoCount = cmaObj("BEZLICZBY", { hasCameras: true, cameraCount: null, hasSswin: true });
  // OFI + SSWiN — obie ścieżki naraz: własna załoga PLUS udział w centrum.
  const oBoth = cmaObj("OFICMA", { hasOfi: true, hasSswin: true });

  // Pula centrum monitorowania — pozycja kadrowa bez wskazania obiektu.
  const [hroCma] = db
    .insert(schema.hrObjects)
    .values({ name: `${PREFIX}CMA`, isCmaPool: true })
    .returning()
    .all();
  // Pozycja zmapowana na obiekt OFI — stąd bierze się jego alokacja WPROST.
  const [hroOfi] = db
    .insert(schema.hrObjects)
    .values({ name: `${PREFIX}POSTERUNEK_OFI`, objectId: oBoth.id })
    .returning()
    .all();

  /** Pracownik z jedną umową, jedną wypłatą i wszystkimi godzinami na jednej pozycji. */
  const singlePosition = (name: string, amount: number, hrObjectId: number) => {
    const [e] = db
      .insert(schema.hrEmployees)
      .values({ fullName: `${PREFIX}${name}`, kind: "ochrona", active: true })
      .returning()
      .all();
    const [ct] = db
      .insert(schema.hrContracts)
      .values({
        employeeId: e.id,
        company: comp.name,
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
    db.insert(schema.hrHours)
      .values({ employeeId: e.id, objectId: hrObjectId, year: m1.year, month: m1.month, workedHours: 100 })
      .run();
    return e;
  };
  singlePosition("Dyzurny", 3600, hroCma.id); // cały koszt idzie do puli CMA
  singlePosition("Ofi", 2000, hroOfi.id); // cały koszt idzie WPROST na oBoth

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
  ok("totals: kwoty opisane jako SZACOWANY KOSZT PRACODAWCY, a nie „na rękę”",
    info.costBasis === "employerCost" && info.employer?.applied === true, info);

  /* --- Druga ścieżka: udział w koszcie centrum monitorowania (CMA) ---------
   * Obiekt bez ochrony fizycznej nie ma „swoich" godzin, a mimo to kosztuje —
   * jego sygnały odbiera dyżurny. Pula CMA dzieli się po dozorowanych jednostkach:
   * SSWiN 1, wideorecepcja 1, każda kamera 1.
   *
   * Zakres `all`, bo jedna z fikstur jest archiwalna i musi być WIDOCZNA w wierszach,
   * żeby dało się sprawdzić, że udziału NIE dostała.
   */
  const cmaCall = () => call("/obiekty?scope=all&costWindow=1");
  const cmaView = await cmaCall();
  const cma = cmaView.totals.personnel.cma;
  const cmaRow = (n: string) => cmaView.rows.find((r: any) => r.name === `${PREFIX}${n}`);
  /** Udziały to round2(perUnit × jednostki), więc porównania robimy z tolerancją grosza. */
  const CENT = 0.011;

  ok("cma: pula niezerowa i podzielona przez niezerowy mianownik",
    cma.poolPositions >= 1 && cma.pool > 0 && cma.units > 0, cma);
  ok("cma: perUnit = pula / jednostki", near(cma.perUnit, round2(cma.pool / cma.units), CENT), cma);

  // (a) kamery liczą się po jednej za sztukę
  ok("4 kamery dostają dokładnie dwa razy tyle, co 2 kamery",
    near(cmaRow("CAM4")?.personnelCmaCost, 2 * cmaRow("CAM2")?.personnelCmaCost, CENT),
    { cam4: cmaRow("CAM4")?.personnelCmaCost, cam2: cmaRow("CAM2")?.personnelCmaCost });
  ok("CAM4: jednostki = 4, udział = 4 × perUnit",
    cmaRow("CAM4")?.serviceUnits === 4 && near(cmaRow("CAM4")?.personnelCmaCost, 4 * cma.perUnit, CENT),
    cmaRow("CAM4"));

  // (b) SSWiN i wideorecepcja po JEDNYM
  ok("SSWiN = 1 jednostka = perUnit",
    cmaRow("SSWIN")?.serviceUnits === 1 && near(cmaRow("SSWIN")?.personnelCmaCost, cma.perUnit, CENT),
    cmaRow("SSWIN"));
  ok("Wideorecepcja waży tyle samo, co SSWiN",
    cmaRow("WIDEO")?.serviceUnits === 1 &&
      near(cmaRow("WIDEO")?.personnelCmaCost, cmaRow("SSWIN")?.personnelCmaCost),
    { wideo: cmaRow("WIDEO")?.personnelCmaCost, sswin: cmaRow("SSWIN")?.personnelCmaCost });

  // (c) archiwalny NIE wchodzi do mianownika — nie dostaje udziału i nie rozcieńcza
  //     kosztu pozostałym. Zmianę statusu robimy BEZ czyszczenia cache'u: odcisk
  //     musi obejmować tabelę `objects`, inaczej wynik by się nie odświeżył.
  ok("Archiwalny: ma 5 jednostek, ale udziału w CMA nie dostaje",
    cmaRow("ARCH")?.serviceUnits === 5 && cmaRow("ARCH")?.personnelCmaCost === 0, cmaRow("ARCH"));
  db.update(schema.objects).set({ status: "active" }).where(eq(schema.objects.id, oArch.id)).run();
  const revived = await cmaCall();
  const revivedRow = revived.rows.find((r: any) => r.name === `${PREFIX}ARCH`);
  ok("Po odarchiwizowaniu jego 5 jednostek WCHODZI do mianownika",
    revived.totals.personnel.cma.units === cma.units + 5 && revivedRow?.personnelCmaCost > 0,
    { before: cma.units, after: revived.totals.personnel.cma.units });
  ok("...a większy mianownik obniża udział pozostałym obiektom",
    revived.rows.find((r: any) => r.name === `${PREFIX}SSWIN`)?.personnelCmaCost <
      cmaRow("SSWIN")?.personnelCmaCost,
    { before: cmaRow("SSWIN")?.personnelCmaCost });
  db.update(schema.objects).set({ status: "inactive" }).where(eq(schema.objects.id, oArch.id)).run();

  // (d) kamery BEZ podanej liczby — brak wagi za kamery, ale zgłoszony osobno
  ok("Kamery bez liczby: waga tylko z SSWiN-u (1), a nie z kamer",
    cmaRow("BEZLICZBY")?.serviceUnits === 1 &&
      near(cmaRow("BEZLICZBY")?.personnelCmaCost, cma.perUnit, CENT),
    cmaRow("BEZLICZBY"));
  ok("Brak liczby kamer jest RAPORTOWANY, a nie połykany",
    cma.objectsMissingCameraCount >= 1, cma);
  db.update(schema.objects).set({ cameraCount: 3 }).where(eq(schema.objects.id, oNoCount.id)).run();
  const counted = await cmaCall(); // znowu bez clearPersonnelCostCache()
  const countedRow = counted.rows.find((r: any) => r.name === `${PREFIX}BEZLICZBY`);
  ok("Uzupełnienie liczby kamer podnosi wagę do 4 i zdejmuje obiekt z listy braków",
    countedRow?.serviceUnits === 4 &&
      counted.totals.personnel.cma.objectsMissingCameraCount === cma.objectsMissingCameraCount - 1 &&
      countedRow?.personnelCmaCost > cmaRow("BEZLICZBY")?.personnelCmaCost,
    { units: countedRow?.serviceUnits, missing: counted.totals.personnel.cma.objectsMissingCameraCount });
  db.update(schema.objects).set({ cameraCount: null }).where(eq(schema.objects.id, oNoCount.id)).run();

  // (e) obie ścieżki SIĘ SUMUJĄ, a nie zastępują
  const both = cmaRow("OFICMA");
  ok("OFI: alokacja wprost = 2 000 (cała wypłata pracownika tego obiektu)",
    near(both?.personnelDirectCost, 2000), both);
  ok("OFI + SSWiN: do tego dochodzi udział w CMA za 1 jednostkę",
    near(both?.personnelCmaCost, cma.perUnit, CENT) && both?.personnelCmaCost > 0, both);
  ok("Koszt osobowy = alokacja wprost + udział CMA (suma, nie podmiana)",
    near(both?.personnelCost, both?.personnelDirectCost + both?.personnelCmaCost, CENT) &&
      both?.personnelCost > 2000,
    both);
  ok("Obiekt bez usług CMA (O8) nie dostaje udziału, ale ma alokację wprost",
    cmaRow("O8")?.personnelCmaCost === 0 && cmaRow("O8")?.personnelDirectCost > 0, cmaRow("O8"));

  // (f) przekrój po usługach — kubełki NIE są rozłączne
  const svc = (k: string) => cmaView.byService.find((b: any) => b.key === k);
  ok("byService ma cztery stałe kubełki (ofi, kamery, sswin, wideorecepcja)",
    cmaView.byService.length === 4 &&
      ["ofi", "kamery", "sswin", "wideorecepcja"].every((k) => svc(k) !== undefined),
    cmaView.byService?.map((b: any) => b.key));
  ok("Obiekt z dwiema usługami wpada do DWÓCH kubełków (podział nierozłączny)",
    (svc("sswin")?.count ?? 0) >= 3 && (svc("kamery")?.count ?? 0) >= 4 && (svc("ofi")?.count ?? 0) >= 1,
    cmaView.byService);

  // (g) rozbicie w rolce kontrahenta
  const ksCma = await call("/kontrahenci?scope=all&costWindow=1");
  const k5 = ksCma.rows.find((r: any) => r.name === `${PREFIX}Kontrahent5`);
  ok("K5: rolka kontrahenta niesie obie ścieżki i ich sumę",
    near(k5?.personnelCost, k5?.personnelDirectCost + k5?.personnelCmaCost, CENT) &&
      k5?.personnelCmaCost > 0 && near(k5?.personnelDirectCost, 2000),
    k5);

  // (h) brak pozycji z is_cma_pool → mechanizm nieaktywny, nic się nie psuje
  const poolIds = db
    .select({ id: schema.hrObjects.id })
    .from(schema.hrObjects)
    .where(eq(schema.hrObjects.isCmaPool, true))
    .all()
    .map((r) => r.id);
  disabledPools.push(...poolIds);
  db.update(schema.hrObjects).set({ isCmaPool: false }).where(inArray(schema.hrObjects.id, poolIds)).run();
  const noPool = await cmaCall(); // i znowu: odcisk ma to złapać sam
  const npInfo = noPool.totals.personnel.cma;
  const npRow = (n: string) => noPool.rows.find((r: any) => r.name === `${PREFIX}${n}`);
  ok("Bez pozycji-puli: pool = 0, perUnit = 0, żadnych udziałów — i zero wyjątków",
    npInfo.poolPositions === 0 && npInfo.pool === 0 && npInfo.perUnit === 0 &&
      npRow("CAM4")?.personnelCmaCost === 0 && npRow("SSWIN")?.personnelCmaCost === 0,
    npInfo);
  ok("Bez puli koszt obiektu OFI to sama alokacja wprost (2 000)",
    near(npRow("OFICMA")?.personnelCost, 2000), npRow("OFICMA"));
  ok("Bez puli mianownik dalej się liczy — jest co dzielić, gdy pula wróci",
    npInfo.units === cma.units && npInfo.objectsInDenominator === cma.objectsInDenominator, npInfo);
  restoreCmaPools();
  clearPersonnelCostCache();

  /* --- Składki pracodawcy -------------------------------------------------
   * Od tego miejsca narzuty są RÓŻNE (MK), więc każda kwota kosztu osobowego to
   * już „wypłata netto × narzut formy zatrudnienia".
   *
   * Punkt odniesienia bez zmian: pracownik ma 3 000 zł netto i połowę godzin na O8,
   * czyli na obiekt idzie 1 500 zł netto × narzut.
   */
  setMarkup("employerMarkupUop", MK.uop);
  setMarkup("employerMarkupZlecenieZua", MK.zlecenieZua);
  setMarkup("employerMarkupZlecenieZza", MK.zlecenieZza);
  setMarkup("employerMarkupOfficeDefault", MK.officeDefault);
  clearPersonnelCostCache();

  const o8cost = async () => {
    const d = await call("/obiekty?scope=current&costWindow=1");
    return d.rows.find((r: any) => r.name === `${PREFIX}O8`);
  };
  const setForm = (v: Partial<typeof schema.hrContracts.$inferInsert>) => {
    db.update(schema.hrContracts).set(v).where(eq(schema.hrContracts.id, contract.id)).run();
    clearPersonnelCostCache();
  };

  // (a) ta sama wypłata, trzy formy zatrudnienia → trzy różne koszty
  const zua = await o8cost();
  ok(`Zlecenie ZUA: 1 500 netto × ${MK.zlecenieZua}`,
    near(zua?.personnelCost, 1500 * MK.zlecenieZua), zua);

  setForm({ contractType: "praca", zua: "tak", zza: "" });
  const uop = await o8cost();
  ok(`Umowa o pracę: 1 500 netto × ${MK.uop}`, near(uop?.personnelCost, 1500 * MK.uop), uop);

  setForm({ contractType: "zlecenie", zua: "", zza: "tak" });
  const zza = await o8cost();
  ok(`Zlecenie ZZA (pracodawca nie dopłaca): 1 500 netto × ${MK.zlecenieZza}`,
    near(zza?.personnelCost, 1500 * MK.zlecenieZza), zza);
  ok("Ta sama wypłata na UoP i na ZZA daje różny koszt, w proporcji narzutów",
    near(uop.personnelCost / zza.personnelCost, MK.uop / MK.zlecenieZza),
    { uop: uop.personnelCost, zza: zza.personnelCost });

  // (b) nadpisanie per spółka wygrywa z globalnym
  db.update(schema.companies)
    .set({ employerMarkupZlecenieZza: 3 })
    .where(eq(schema.companies.id, comp.id))
    .run();
  clearPersonnelCostCache();
  const overridden = await o8cost();
  ok("Nadpisanie spółki (×3) wygrywa z narzutem globalnym",
    near(overridden?.personnelCost, 1500 * 3) &&
      !near(overridden?.personnelCost, 1500 * MK.zlecenieZza), overridden);
  const ovInfo = (await call("/obiekty?scope=current&costWindow=1")).totals.personnel.employer;
  ok("Nadpisanie widać w audycie (companyOverrides ≥ 1), a `markups` pokazuje wartości GLOBALNE",
    ovInfo.companyOverrides >= 1 && near(ovInfo.markups.zlecenieZza, MK.zlecenieZza), ovInfo);

  db.update(schema.companies)
    .set({ employerMarkupZlecenieZza: null })
    .where(eq(schema.companies.id, comp.id))
    .run();
  setForm({ contractType: "zlecenie", zua: "tak", zza: "" }); // powrót do stanu bazowego

  // (c) rozliczenie biura BEZ umowy w kadrach → narzut domyślny
  // (w produkcyjnej bazie to 156 ze 168 wierszy biura — formy nie ma skąd odczytać).
  const [officeEmp] = db
    .insert(schema.hrEmployees)
    .values({ fullName: `${PREFIX}Biuro`, kind: "biuro", active: true })
    .returning()
    .all();
  db.insert(schema.hrOfficePayroll)
    .values({ employeeId: officeEmp.id, year: m1.year, month: m1.month, rorBase: 1000 })
    .run();
  // Godziny WYŁĄCZNIE na pozycji zmapowanej — całe 1 000 zł idzie na O8, więc kwotę
  // da się rozdzielić na składnik „umowa" i składnik „biuro" bez zgadywania.
  db.insert(schema.hrHours)
    .values({ employeeId: officeEmp.id, objectId: hroMapped.id, year: m1.year, month: m1.month, workedHours: 100 })
    .run();
  clearPersonnelCostCache();

  const withOffice = await o8cost();
  ok(`Biuro bez umowy: 1 000 zł × narzut domyślny ${MK.officeDefault} (razem z umową ${1500 * MK.zlecenieZua})`,
    near(withOffice?.personnelCost, 1500 * MK.zlecenieZua + 1000 * MK.officeDefault), withOffice);

  // ...a gdy umowa ISTNIEJE, wygrywa jej forma (umowa bez wypłaty — sam nośnik formy).
  const [officeContract] = db
    .insert(schema.hrContracts)
    .values({
      employeeId: officeEmp.id,
      company: comp.name,
      contractType: "praca",
      zua: "tak",
      mainChannel: "przelew",
      bonusType: "brak",
      active: true,
    })
    .returning()
    .all();
  clearPersonnelCostCache();
  const officeWithContract = await o8cost();
  ok(`Biuro Z umową: forma z umowy (${MK.uop}) wygrywa z narzutem domyślnym`,
    near(officeWithContract?.personnelCost, 1500 * MK.zlecenieZua + 1000 * MK.uop),
    officeWithContract);
  db.delete(schema.hrContracts).where(eq(schema.hrContracts.id, officeContract.id)).run();
  clearPersonnelCostCache();

  // (d) audyt: rozkład wierszy i narzut wypadkowy
  const emp1 = (await call("/obiekty?scope=current&costWindow=1")).totals.personnel.employer;
  ok("byForm liczy wiersze: zlecenie ZUA (umowa) i fallback biura",
    emp1.byForm.zlecenieZua >= 1 && emp1.byForm.officeFallback >= 1, emp1.byForm);
  ok("markups w audycie = ustawione wartości globalne",
    near(emp1.markups.uop, MK.uop) &&
      near(emp1.markups.zlecenieZua, MK.zlecenieZua) &&
      near(emp1.markups.zlecenieZza, MK.zlecenieZza) &&
      near(emp1.markups.officeDefault, MK.officeDefault), emp1.markups);

  // effectiveMarkup = koszt łączny / wypłaty netto łącznie, więc z definicji leży
  // między najniższym a najwyższym FAKTYCZNIE użytym narzutem. Sprawdzamy to tylko,
  // gdy żadna spółka nie ma nadpisania — nadpisanie może legalnie wyjść poza globalne.
  const usedGlobals = [
    emp1.byForm.uop ? MK.uop : null,
    emp1.byForm.zlecenieZua ? MK.zlecenieZua : null,
    emp1.byForm.zlecenieZza ? MK.zlecenieZza : null,
    emp1.byForm.officeFallback ? MK.officeDefault : null,
  ].filter((v): v is number => v !== null);
  if (emp1.companyOverrides === 0) {
    ok("effectiveMarkup mieści się między najniższym a najwyższym użytym narzutem",
      emp1.effectiveMarkup >= Math.min(...usedGlobals) - 0.001 &&
        emp1.effectiveMarkup <= Math.max(...usedGlobals) + 0.001,
      { effectiveMarkup: emp1.effectiveMarkup, usedGlobals });
  } else {
    ok("effectiveMarkup ≥ 1 (są nadpisania per spółka, więc granice globalne nie obowiązują)",
      emp1.effectiveMarkup >= 1, emp1);
  }

  // (e) zmiana USTAWIENIA unieważnia cache — bez tego admin zmieniłby narzut
  //     w panelu i zobaczył stare liczby (dane kadrowe przecież nie drgnęły).
  const before = await o8cost();
  setSetting(markupKey("employerMarkupZlecenieZua"), String(MK.zlecenieZza), null); // BEZ clearPersonnelCostCache()
  const after = await o8cost();
  ok("Zmiana narzutu w ustawieniach przelicza koszt bez ręcznego czyszczenia cache’u",
    !near(after?.personnelCost, before.personnelCost) &&
      near(after?.personnelCost, 1500 * MK.zlecenieZza + 1000 * MK.officeDefault),
    { before: before.personnelCost, after: after?.personnelCost });
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
