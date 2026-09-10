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
import objectsApp from "../src/routes/objects.js";
import {
  clearPersonnelCostCache,
  fullMonths,
  type MonthKey,
} from "../src/lib/object-personnel-cost.js";
import {
  isoPlusDays,
  monthBounds,
  syncObjectServiceFlags,
  todayIso,
  upsertServiceRowsFromFlags,
} from "../src/lib/object-services.js";
import { COMPANY_FIELDS } from "../src/lib/company-config.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";

/**
 * BLOKADA: ten test zmienia stan GLOBALNY, nie tylko własne fikstury — przestawia
 * narzuty składek w `app_settings` i wyłącza pulę CMA, żeby liczyć arytmetykę przy
 * znanych wartościach. Odtworzenie wisi na `finally`, więc przerwany proces
 * (SIGKILL, OOM, restart kontenera) zostawiłby firmie zerowy koszt centrum
 * monitorowania i koszty osobowe bez składek — po cichu.
 *
 * Dlatego wymagamy jawnie wskazanej bazy. Najprościej:
 *   npx tsx scripts/test-on-copy.ts scripts/test-analytics.ts
 */
if (!process.env.ALFA_DB_PATH) {
  console.error(
    "Ten test zmienia ustawienia globalne, więc nie uruchamia się na domyślnej bazie.\n" +
      "Użyj:  npx tsx scripts/test-on-copy.ts scripts/test-analytics.ts"
  );
  process.exit(1);
}

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
 * Działy, którym test CHWILOWO zdjął `is_cma_pool` (żeby sprawdzić, że bez puli nic
 * się nie sypie). Trzymamy ich id poza `main()`, bo gdyby test wywalił się w środku
 * tej sekcji, produkcyjny dział „CMA" zostałby wyłączony — a wtedy cała firma po cichu
 * przestałaby rozdzielać koszt centrum.
 */
const disabledPools: number[] = [];

function restoreCmaPools() {
  if (!disabledPools.length) return;
  db.update(schema.hrDepartments)
    .set({ isCmaPool: true })
    .where(inArray(schema.hrDepartments.id, disabledPools))
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
  db.delete(schema.hrDepartments).where(like(schema.hrDepartments.name, `${PREFIX}%`)).run();

  const objIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (objIds.length) {
    db.delete(schema.objectHistory).where(inArray(schema.objectHistory.objectId, objIds)).run();
    // Okresy usług kasujemy JAWNIE, mimo ON DELETE CASCADE: kaskada działa tylko
    // przy `foreign_keys = ON`, a wiersze fikstur w tabeli mianownika CMA to
    // ostatnia rzecz, którą wolno zostawić po teście w prawdziwej bazie.
    db.delete(schema.objectServices).where(inArray(schema.objectServices.objectId, objIds)).run();
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

  /*
   * Obiekt fikstury + JEGO OKRESY USŁUG.
   *
   * Od migracji 0084 flagi `has_*` są tylko cache'em, a mianownik kosztu CMA per
   * miesiąc i seria czasowa analityki liczą się z wierszy `object_services`.
   * Fikstura musi więc mieć jedno i drugie — inaczej testowałaby ścieżkę D3
   * („obiekt bez okresów, liczony z flag") zamiast normalnego obiektu kartoteki.
   *
   * Domyślny start (`SERVICE_START`) leży przed każdym oknem, jakie analityka
   * liczy (12 miesięcy kosztu, 12 miesięcy serii czasowej), więc wszystkie
   * dotychczasowe asercje dostają dokładnie te same liczby, co przed zmianą.
   * Obiekt bez ani jednej usługi (O1..O7) nie dostaje żadnego wiersza.
   */
  const SERVICE_START = "2019-01-01";
  const obj = (
    v: Partial<typeof schema.objects.$inferInsert>,
    services: { startDate?: string; endDate?: string | null; startEstimated?: boolean } = {}
  ) => {
    const row = db
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
    upsertServiceRowsFromFlags(db, row.id, row, services.startDate ?? SERVICE_START, {
      endDate: services.endDate ?? null,
      startEstimated: services.startEstimated ?? false,
    });
    return row;
  };

  // O1 — własny handlowiec A (nadpisuje opiekuna kontrahenta): 20 000 przychodu, 8 000 kosztu.
  obj({ name: `${PREFIX}O1`, monthlyZdw: 20000, monthlyCost: 8000, salespersonId: spA.id });
  // O2 — koszt NULL („nieuzupełniony”). O3 — koszt 0 zł (uzupełniony fakt). Oba dziedziczą B.
  obj({ name: `${PREFIX}O2`, monthlyZdw: 1000, monthlyCost: null });
  obj({ name: `${PREFIX}O3`, monthlyZdw: 1000, monthlyCost: 0 });
  // O4 — zwrot z instalacji: 12 000 / (2 000 − 1 000) = 12 miesięcy.
  obj({ name: `${PREFIX}O4`, monthlyZdw: 2000, monthlyCost: 1000, setupCost: 12000 });
  // O5 — archiwalny: widoczny tylko w scope=all.
  obj({ name: `${PREFIX}O5`, monthlyZdw: 999, monthlyCost: 1, status: "inactive" });
  // O6 — kontrahent bez opiekuna → „Bez handlowca”.
  obj({ name: `${PREFIX}O6`, contractorId: c2.id, monthlyZdw: 700, monthlyCost: 200 });

  // Kontrahent 3 — ŻADEN jego obiekt nie ma kosztu. To stan „dnia pierwszego”:
  // zysk równa się przychodowi tylko dlatego, że koszty policzyliśmy jako zero,
  // więc marża musi być nieznana (null), a nie 100%.
  const [c3] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent3`, nip: `${PREFIX}3`, salespersonId: null })
    .returning()
    .all();
  obj({ name: `${PREFIX}O7`, contractorId: c3.id, monthlyZdw: 3000, monthlyCost: null });

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
    monthlyZdw: 10000,
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
  const cmaObj = (
    name: string,
    v: Partial<typeof schema.objects.$inferInsert>,
    services: { startDate?: string; endDate?: string | null; startEstimated?: boolean } = {}
  ) => obj({ name: `${PREFIX}${name}`, contractorId: c5.id, monthlyZdw: 0, ...v }, services);

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

  /* --- Fikstury OKRESÓW: seria czasowa, mianownik per miesiąc, „kończące się"
   *
   * Wszystkie liczone względem DZISIAJ w strefie aplikacji — tej samej, w której
   * analityka wyznacza miesiące serii i horyzont „kończy się wkrótce".
   */
  const TODAY = todayIso();
  /** Miesiąc oddalony o `offset` od bieżącego (offset ujemny = wstecz). */
  const monthAt = (offset: number): MonthKey => {
    const idx = Number(TODAY.slice(0, 4)) * 12 + Number(TODAY.slice(5, 7)) - 1 + offset;
    return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
  };
  const mStarted = monthAt(-2); // miesiąc rozpoczęcia usługi „świeżego" obiektu
  const mPrev = monthAt(-1); // zeszły miesiąc = miesiąc zakończenia usługi
  const startedFrom = monthBounds(mStarted.year, mStarted.month).from;
  const endedOn = monthBounds(mPrev.year, mPrev.month).to;

  // SWIEZY — 2 kamery od pierwszego dnia miesiąca sprzed dwóch. Tyle samo jednostek,
  // co CAM2, ale krótsza historia: przy oknie 12 miesięcy jego udział w koszcie
  // centrum MUSI być mniejszy, bo przez większość okna centrum go nie dozorowało.
  const oFresh = cmaObj("SWIEZY", { hasCameras: true, cameraCount: 2 }, { startDate: startedFrom });
  // ZAKONCZONY — jedyny okres domknięty w ZESZŁYM miesiącu: wchodzi do `ended`
  // tamtego miesiąca i NIE jest „kończący się" (już się skończył, nie kończy).
  const oEnded = cmaObj(
    "ZAKONCZONY",
    { hasCameras: true, cameraCount: 1 },
    { endDate: endedOn }
  );
  // Cache flag musi znać koniec okresu — w aplikacji robi to trasa zapisu.
  syncObjectServiceFlags(db, oEnded.id);
  // KONCZY — bez usług, ale z wpisanym przewidywanym zakończeniem za 30 dni:
  // druga, niezależna ścieżka predykatu „kończy się".
  obj({
    name: `${PREFIX}KONCZY`,
    contractorId: c5.id,
    monthlyZdw: 700,
    expectedEndDate: isoPlusDays(TODAY, 30),
  });
  // DLUGI — jedyny okres kończy się za 200 dni: poza horyzontem 90 dni, w horyzoncie 365.
  cmaObj("DLUGI", { hasCameras: true, cameraCount: 1 }, { endDate: isoPlusDays(TODAY, 200) });

  // Pula centrum monitorowania — DZIAŁ, nie pozycja obiektowa. Godziny działowe
  // z definicji nie należą do żadnego obiektu; pula rozdziela ich koszt po
  // wszystkich dozorowanych jednostkach.
  const [depCma] = db
    .insert(schema.hrDepartments)
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
  /**
   * Pracownik z jedną umową, jedną wypłatą i wszystkimi godzinami na JEDNYM przypisaniu.
   * Przypisanie podaje się jako `{ objectId }` albo `{ departmentId }` — dokładnie tak,
   * jak wygląda wiersz godzin po rozdzieleniu obiektów i działów.
   */
  const singlePosition = (
    name: string,
    amount: number,
    assignment: { objectId?: number; departmentId?: number },
    month: MonthKey = m1
  ) => {
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
      .values({ contractId: ct.id, year: month.year, month: month.month, mainAmount: amount })
      .run();
    db.insert(schema.hrHours)
      .values({
        employeeId: e.id,
        objectId: assignment.objectId ?? null,
        departmentId: assignment.departmentId ?? null,
        year: month.year,
        month: month.month,
        workedHours: 100,
      })
      .run();
    return e;
  };
  singlePosition("Dyzurny", 3600, { departmentId: depCma.id }); // cały koszt idzie do puli CMA
  singlePosition("Ofi", 2000, { objectId: hroOfi.id }); // cały koszt idzie WPROST na oBoth
  // Dyżurny w NAJSTARSZYM miesiącu okna 12 — bez niego pula centrum w dawnych
  // miesiącach jest zerowa i nie da się pokazać, że mianownik liczy się PER MIESIĄC
  // (obiekt podłączony niedawno nie może dostać udziału za miesiąc sprzed roku).
  const mOldest = fullMonths(12)[0];
  singlePosition("DyzurnyStary", 3600, { departmentId: depCma.id }, mOldest);

  /* --- Fikstura HISTORII PŁAC: okna 3 i 12 muszą mieć czym się różnić ------
   *
   * Miesiąc wchodzi do średniej tylko wtedy, gdy ma WPROWADZONE KWOTY wypłat
   * (`hasPayrollAmounts` w src/lib/object-personnel-cost.ts). Prawdziwa kartoteka
   * kadrowa w bazie bywa rozliczona tylko za ostatni miesiąc — wtedy `monthsUsed`
   * wychodzi 1 dla KAŻDEGO okna i asercje o uśrednianiu (1 < 3 ≤ 12) padają na
   * danych, a nie na kodzie. Test nie może zależeć od tego, co księgowa zdążyła
   * wprowadzić, więc rozliczenie brakujących miesięcy dokłada sobie sam.
   *
   * Pracownik NIE MA GODZIN, więc jego koszt zostaje kosztem ogólnym firmy i nie
   * zmienia ani jednej kwoty na obiekcie — jedynym efektem jest to, że miesiąc
   * liczy się jako rozliczony i wchodzi do mianownika średniej.
   */
  const [histEmp] = db
    .insert(schema.hrEmployees)
    .values({ fullName: `${PREFIX}Historia`, kind: "ochrona", active: true })
    .returning()
    .all();
  const [histContract] = db
    .insert(schema.hrContracts)
    .values({
      employeeId: histEmp.id,
      company: comp.name,
      contractType: "zlecenie",
      zua: "tak",
      mainChannel: "przelew",
      bonusType: "brak",
      active: true,
    })
    .returning()
    .all();
  for (const m of fullMonths(12)) {
    // Ostatni pełny miesiąc jest już rozliczony fiksturą główną; dokładanie mu
    // drugiej wypłaty zmieniłoby audyt składek bez żadnego zysku dla testu.
    if (m.year === m1.year && m.month === m1.month) continue;
    db.insert(schema.hrPayroll)
      .values({ contractId: histContract.id, year: m.year, month: m.month, mainAmount: 1000 })
      .run();
  }

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

  /*
   * REGRESJA (naprawiona): udział w puli centrum monitorowania zapalał `hasCost`.
   * Dostaje go automatycznie każdy aktywny obiekt z kamerami albo SSWiN-em, więc
   * warunek "personnelCost > 0" czynił koszt "znanym" praktycznie wszędzie —
   * i obiekty bez ŻADNEJ wiedzy o koszcie pokazywały marże rzędu 98%.
   * Udział CMA ma WCHODZIĆ do kosztu, ale nie czynić go znanym.
   */
  /*
   * REGRESJA (naprawiona): miesiąc z wierszami płacowymi, ale BEZ wprowadzonych
   * kwot, był liczony jak pełny. Godziny importuje się wcześniej niż kwoty od
   * księgowości, więc miesiąc czekający na rozliczenie miał komplet wierszy
   * z `main_amount = NULL` — a poprzedni warunek sprawdzał tylko, czy wiersze
   * istnieją. Na produkcji dzieliło to koszt przez 3 zamiast przez 2 i pokazywało
   * +9,9% marży zamiast −2,2%.
   */
  const pInfo = os.totals.personnel;
  ok(
    "Miesiące bez wprowadzonych kwot są pomijane i RAPORTOWANE",
    Array.isArray(pInfo.skippedMonths) &&
      pInfo.monthsUsed === pInfo.months.length &&
      !pInfo.months.some((m: any) =>
        pInfo.skippedMonths.some((s: any) => s.year === m.year && s.month === m.month)
      ),
    { uzyte: pInfo.months, pominiete: pInfo.skippedMonths }
  );

  const cmaOnly = os.rows.filter(
    (r: any) => r.otherCost === 0 && r.personnelDirectCost === 0 && r.personnelCmaCost > 0
  );
  ok(
    "Sam udział CMA nie zapala hasCost ani marży",
    cmaOnly.every((r: any) => r.hasCost === false && r.margin === null),
    cmaOnly.slice(0, 3).map((r: any) => ({ n: r.name, hasCost: r.hasCost, margin: r.margin }))
  );
  ok(
    "…ale nadal wchodzi do kosztu obiektu",
    cmaOnly.every((r: any) => r.cost >= r.personnelCmaCost - 0.01),
    cmaOnly.slice(0, 2).map((r: any) => ({ n: r.name, cost: r.cost, cma: r.personnelCmaCost }))
  );
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
  /*
   * Liczbę kamer uzupełnia się dziś na OKRESIE USŁUGI, a flagi obiektu przelicza
   * z niego `syncObjectServiceFlags` — dokładnie tak, jak robi to trasa zapisu.
   * Cache kosztu osobowego celowo NIE jest czyszczony: odcisk musi obejmować
   * także tabelę `object_services`, inaczej edycja okresu serwowałaby stary koszt.
   */
  const noCountPeriod = db
    .select({ id: schema.objectServices.id, service: schema.objectServices.service })
    .from(schema.objectServices)
    .where(eq(schema.objectServices.objectId, oNoCount.id))
    .all()
    .find((r) => r.service === "kamery")!;
  const setNoCountCameras = (cameraCount: number | null) => {
    db.update(schema.objectServices)
      .set({ cameraCount, updatedAt: new Date().toISOString() })
      .where(eq(schema.objectServices.id, noCountPeriod.id))
      .run();
    syncObjectServiceFlags(db, oNoCount.id);
  };
  setNoCountCameras(3);
  const counted = await cmaCall(); // znowu bez clearPersonnelCostCache()
  const countedRow = counted.rows.find((r: any) => r.name === `${PREFIX}BEZLICZBY`);
  ok("Uzupełnienie liczby kamer podnosi wagę do 4 i zdejmuje obiekt z listy braków",
    countedRow?.serviceUnits === 4 &&
      counted.totals.personnel.cma.objectsMissingCameraCount === cma.objectsMissingCameraCount - 1 &&
      countedRow?.personnelCmaCost > cmaRow("BEZLICZBY")?.personnelCmaCost,
    { units: countedRow?.serviceUnits, missing: counted.totals.personnel.cma.objectsMissingCameraCount });
  ok("Edycja SAMEGO okresu usługi unieważnia cache kosztu (odcisk zna object_services)",
    countedRow?.personnelCmaCost !== cmaRow("BEZLICZBY")?.personnelCmaCost,
    { przed: cmaRow("BEZLICZBY")?.personnelCmaCost, po: countedRow?.personnelCmaCost });
  setNoCountCameras(null);

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

  // (h) brak działu z is_cma_pool → mechanizm nieaktywny, nic się nie psuje
  const poolIds = db
    .select({ id: schema.hrDepartments.id })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.isCmaPool, true))
    .all()
    .map((r) => r.id);
  disabledPools.push(...poolIds);
  db.update(schema.hrDepartments)
    .set({ isCmaPool: false })
    .where(inArray(schema.hrDepartments.id, poolIds))
    .run();
  const noPool = await cmaCall(); // i znowu: odcisk ma to złapać sam
  const npInfo = noPool.totals.personnel.cma;
  const npRow = (n: string) => noPool.rows.find((r: any) => r.name === `${PREFIX}${n}`);
  ok("Bez działu-puli: pool = 0, perUnit = 0, żadnych udziałów — i zero wyjątków",
    npInfo.poolPositions === 0 && npInfo.pool === 0 && npInfo.perUnit === 0 &&
      npRow("CAM4")?.personnelCmaCost === 0 && npRow("SSWIN")?.personnelCmaCost === 0,
    npInfo);
  ok("Bez puli koszt obiektu OFI to sama alokacja wprost (2 000)",
    near(npRow("OFICMA")?.personnelCost, 2000), npRow("OFICMA"));
  ok("Bez puli mianownik dalej się liczy — jest co dzielić, gdy pula wróci",
    npInfo.units === cma.units && npInfo.objectsInDenominator === cma.objectsInDenominator, npInfo);
  restoreCmaPools();
  clearPersonnelCostCache();

  /* --- Przekrój usługowy: service=zdv | ofi | all --------------------------
   * Firma sprzedaje dwie różne rzeczy — zdalny dozór (kamery/SSWiN/wideorecepcja,
   * obsługiwany z centrum) i ochronę fizyczną (ludzie na obiekcie). Parametr
   * `service` zawęża CAŁĄ analitykę do jednej z nich PRZED agregacją.
   *
   * Dwie rzeczy, które muszą być tu przybite gwoździami:
   *  1. obiekt z OFI i kamerami POLICZY SIĘ w obu przekrojach (licznik obiektów
   *     się dubluje), ale wchodzi tam tylko SWOJĄ CZĘŚCIĄ abonamentu — więc
   *     przychód „zdv" + „ofi" NIE jest większy od „all". Od rozbicia abonamentu
   *     (migracja 0082) jest mu równy, pomniejszony wyłącznie o obiekty bez ani
   *     jednej usługi, które nie należą do żadnej linii;
   *  2. koszt osobowy zmienia SKŁAD, nie tylko zbiór wierszy: w „ofi" liczą się
   *     wyłącznie godziny na obiekcie, w „zdv" wyłącznie udział w puli CMA.
   */
  const [c6] = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX}Kontrahent6`, nip: `${PREFIX}6` })
    .returning()
    .all();
  // Mieszany: ochrona fizyczna PLUS kamera, z przychodem i wpisanym kosztem
  // pozostałym. Abonament jest ROZBITY (3 000 za dozór + 2 000 za wartownika) —
  // na nim widać, że przychód idzie za linią, a koszt pozostały nie.
  const oMix = obj({
    name: `${PREFIX}MIESZANY`,
    contractorId: c6.id,
    monthlyZdw: 3000,
    monthlyOfi: 2000,
    monthlyCost: 400,
    hasOfi: true,
    hasCameras: true,
    cameraCount: 1,
  });
  // Czysty OFI — nie ma prawa pojawić się w przekroju „zdv".
  obj({
    name: `${PREFIX}TYLKOOFI`,
    contractorId: c6.id,
    monthlyOfi: 1200,
    monthlyCost: 100,
    hasOfi: true,
  });
  const [hroMix] = db
    .insert(schema.hrObjects)
    .values({ name: `${PREFIX}POSTERUNEK_MIX`, objectId: oMix.id })
    .returning()
    .all();
  singlePosition("MixOfi", 1000, { objectId: hroMix.id }); // 1 000 zł wprost na oMix
  clearPersonnelCostCache();

  // `limit` z zapasem: bilanse niżej liczymy z WIERSZY, więc nie mogą być przycięte.
  const serviceView = (s: string) =>
    call(`/obiekty?scope=all&costWindow=1&limit=5000&service=${s}`);
  const vAll = await serviceView("all");
  const vZdv = await serviceView("zdv");
  const vOfi = await serviceView("ofi");
  const row = (v: any, n: string) => v.rows.find((r: any) => r.name === `${PREFIX}${n}`);
  const isZdv = (r: any) => r.services.cameras || r.services.sswin || r.services.videoreception;

  ok("service jest echem w odpowiedzi (kontrakt dla UI)",
    vAll.service === "all" && vZdv.service === "zdv" && vOfi.service === "ofi",
    { all: vAll.service, zdv: vZdv.service, ofi: vOfi.service });

  // (a) zbiór wierszy
  ok("service=ofi zwraca WYŁĄCZNIE obiekty z ochroną fizyczną",
    vOfi.rows.length > 0 && vOfi.rows.every((r: any) => r.services.ofi === true),
    vOfi.rows.filter((r: any) => !r.services.ofi).slice(0, 3));
  ok("service=zdv zwraca WYŁĄCZNIE obiekty z kamerami / SSWiN-em / wideorecepcją",
    vZdv.rows.length > 0 && vZdv.rows.every(isZdv),
    vZdv.rows.filter((r: any) => !isZdv(r)).slice(0, 3));
  ok("Czysty OFI jest w „ofi” i NIE MA go w „zdv”",
    !!row(vOfi, "TYLKOOFI") && !row(vZdv, "TYLKOOFI"), {
      ofi: !!row(vOfi, "TYLKOOFI"),
      zdv: !!row(vZdv, "TYLKOOFI"),
    });
  ok("Obiekt mieszany (OFI + kamera) jest w OBU przekrojach",
    !!row(vOfi, "MIESZANY") && !!row(vZdv, "MIESZANY"));
  ok("Obiekt bez ani jednej usługi (O1) nie wchodzi do żadnego przekroju",
    !row(vOfi, "O1") && !row(vZdv, "O1") && !!row(vAll, "O1"));
  /*
   * Bilans liczby obiektów. NIE porównujemy z „all": w kartotece są obiekty bez
   * ANI JEDNEJ usługi (stare wpisy, wersje robocze) i te nie należą do żadnej
   * linii, więc zdv + ofi bywa MNIEJSZE niż all. Prawdziwa reguła jest taka:
   * suma obu przekrojów = obiekty z jakąkolwiek usługą PLUS te policzone dwa
   * razy, czyli mieszane.
   */
  const withAnyService = vAll.rows.filter((r: any) => r.services.ofi || isZdv(r)).length;
  const mixedCount = vAll.rows.filter((r: any) => r.services.ofi && isZdv(r)).length;
  ok("zdv + ofi = obiekty z usługami + mieszane (te liczą się dwa razy)",
    mixedCount > 0 &&
      vZdv.totals.objects + vOfi.totals.objects === withAnyService + mixedCount,
    {
      zdv: vZdv.totals.objects,
      ofi: vOfi.totals.objects,
      withAnyService,
      mixedCount,
    });

  /* (b) przychód: NIE MA już podwójnego liczenia mieszanych.
   *
   * Do rozbicia abonamentu (migracja 0082) mieszany obiekt wchodził do obu
   * przekrojów CAŁĄ kwotą i „zdv" + „ofi" wychodziło więcej, niż firma ma. Teraz
   * jedyną różnicą wobec „all" są obiekty bez ANI JEDNEJ usługi — nie należą do
   * żadnej linii, więc ich przychód nie pojawia się w żadnym przekroju.
   */
  const noServiceRevenue = vAll.rows
    .filter((r: any) => !r.services.ofi && !isZdv(r))
    .reduce((s: number, r: any) => s + r.revenue, 0);
  ok("Przychód zdv + ofi = przychód all − obiekty bez żadnej usługi",
    near(
      vZdv.totals.revenue + vOfi.totals.revenue,
      vAll.totals.revenue - noServiceRevenue,
      0.011
    ),
    {
      zdv: vZdv.totals.revenue,
      ofi: vOfi.totals.revenue,
      all: vAll.totals.revenue,
      noServiceRevenue,
    });
  ok("Przychód zdv + ofi NIE przekracza przychodu all (koniec podwójnego liczenia)",
    vZdv.totals.revenue + vOfi.totals.revenue <= vAll.totals.revenue + 0.001,
    { zdv: vZdv.totals.revenue, ofi: vOfi.totals.revenue, all: vAll.totals.revenue });
  ok("Obiekt mieszany dzieli przychód między linie (3 000 + 2 000 = 5 000), koszt pozostały zostaje w całości",
    row(vAll, "MIESZANY")?.revenue === 5000 &&
      row(vZdv, "MIESZANY")?.revenue === 3000 &&
      row(vOfi, "MIESZANY")?.revenue === 2000 &&
      row(vZdv, "MIESZANY")?.otherCost === 400 &&
      row(vOfi, "MIESZANY")?.otherCost === 400,
    { all: row(vAll, "MIESZANY"), zdv: row(vZdv, "MIESZANY"), ofi: row(vOfi, "MIESZANY") });

  // (c) koszt osobowy zmienia SKŁAD, nie tylko zbiór
  const mixAll = row(vAll, "MIESZANY");
  const mixZdv = row(vZdv, "MIESZANY");
  const mixOfi = row(vOfi, "MIESZANY");
  ok("all: obie ścieżki naraz (godziny na obiekcie + udział w puli CMA)",
    near(mixAll?.personnelDirectCost, 1000) &&
      mixAll?.personnelCmaCost > 0 &&
      near(mixAll?.personnelCost, mixAll.personnelDirectCost + mixAll.personnelCmaCost, 0.011),
    mixAll);
  ok("ofi: koszt osobowy = SAME godziny na obiekcie, bez udziału w CMA",
    near(mixOfi?.personnelCost, 1000) &&
      near(mixOfi?.personnelDirectCost, 1000) &&
      mixOfi?.personnelCmaCost === 0,
    mixOfi);
  ok("zdv: koszt osobowy = SAM udział w puli CMA, bez pensji wartowników",
    mixZdv?.personnelDirectCost === 0 &&
      near(mixZdv?.personnelCmaCost, mixAll.personnelCmaCost, 0.011) &&
      near(mixZdv?.personnelCost, mixAll.personnelCmaCost, 0.011),
    mixZdv);
  ok("zdv + ofi składają się z powrotem na koszt osobowy z „all”",
    near(mixZdv.personnelCost + mixOfi.personnelCost, mixAll.personnelCost, 0.011),
    { zdv: mixZdv.personnelCost, ofi: mixOfi.personnelCost, all: mixAll.personnelCost });
  // Zysk przekroju liczy się z JEGO WŁASNEGO przychodu i JEGO WŁASNEGO kosztu:
  // ofi = 2 000 − 1 000 (godziny) − 400 (koszt pozostały),
  // zdv = 3 000 − udział w puli CMA − 400.
  ok("Zysk przekroju liczy się z jego własnego przychodu i kosztu",
    near(mixOfi?.profit, 2000 - 1000 - 400) &&
      near(mixZdv?.profit, 3000 - mixAll.personnelCmaCost - 400, 0.011),
    { ofi: mixOfi?.profit, zdv: mixZdv?.profit });

  // (d) `hasCost` liczy się na nowo: godziny wartowników nie czynią kosztu
  //     obiektu ZNANYM w przekroju dozoru (OFICMA nie ma wpisanego monthly_cost).
  ok("all: OFICMA ma koszt ZNANY (są godziny na obiekcie)",
    row(vAll, "OFICMA")?.hasCost === true, row(vAll, "OFICMA"));
  ok("zdv: ten sam obiekt ma koszt NIEZNANY — jego godziny należą do OFI",
    row(vZdv, "OFICMA")?.hasCost === false && row(vZdv, "OFICMA")?.margin === null,
    row(vZdv, "OFICMA"));

  // (e) nieznana wartość parametru = domyślne „all" (tak samo jak `scope`)
  const bogus = await serviceView("kamery-i-psy");
  ok("Nieznany service wraca do domyślnego „all”, a nie wywala zapytania",
    bogus.service === "all" &&
      bogus.rows.length === vAll.rows.length &&
      near(bogus.totals.revenue, vAll.totals.revenue),
    { service: bogus.service, rows: bogus.rows.length });

  // (f) filtr działa PRZED agregacją, więc dotyczy też dwóch pozostałych widoków
  const kOfi = await call(`/kontrahenci?scope=all&costWindow=1&service=ofi`);
  const kAll = await call(`/kontrahenci?scope=all&costWindow=1`);
  ok("kontrahenci: przekroj zawęża też ten widok (te same sumy, co w obiektach)",
    kOfi.service === "ofi" && near(kOfi.totals.revenue, vOfi.totals.revenue, 0.011),
    { kontrahenci: kOfi.totals.revenue, obiekty: vOfi.totals.revenue });
  ok("kontrahenci: klient bez obiektów w przekroju wypada z rankingu",
    !!kOfi.rows.find((r: any) => r.name === `${PREFIX}Kontrahent6`) &&
      !kOfi.rows.find((r: any) => r.name === `${PREFIX}Kontrahent1`) &&
      !!kAll.rows.find((r: any) => r.name === `${PREFIX}Kontrahent1`),
    kOfi.rows.map((r: any) => r.name));
  ok("kontrahenci: licznik „bez obiektów” rośnie o tych spoza przekroju",
    kOfi.contractorsWithoutObjects > kAll.contractorsWithoutObjects,
    { ofi: kOfi.contractorsWithoutObjects, all: kAll.contractorsWithoutObjects });

  const hOfi = await call(`/handlowcy?scope=all&costWindow=1&service=ofi`);
  ok("handlowcy: portfele liczone z przefiltrowanych obiektów",
    hOfi.service === "ofi" &&
      near(hOfi.totals.revenue, vOfi.totals.revenue, 0.011) &&
      near(hOfi.totals.cost, vOfi.totals.cost, 0.011),
    { handlowcy: hOfi.totals.revenue, obiekty: vOfi.totals.revenue });

  /* --- Mianownik kosztu CMA liczony PER MIESIĄC ---------------------------
   * Do września 2026 dwunastomiesięczny koszt centrum dzielił się DZISIEJSZYMI
   * kamerami: obiekt podłączony dwa miesiące temu dostawał udział także za
   * miesiące, w których centrum go nie dozorowało. Od czasu okresów usług każdy
   * miesiąc okna dzieli swoją pulę po usługach aktywnych W TYM MIESIĄCU.
   */
  const wide = (w: number) => call(`/obiekty?scope=all&costWindow=${w}&limit=5000`);
  const w1 = await wide(1);
  const w12 = await wide(12);
  const rowOf = (v: any, n: string) => v.rows.find((r: any) => r.name === `${PREFIX}${n}`);

  ok("okno 1 mies.: świeży obiekt i CAM2 mają po 2 jednostki i równy udział w puli",
    rowOf(w1, "SWIEZY")?.personnelCmaCost > 0 &&
      near(rowOf(w1, "SWIEZY")?.personnelCmaCost, rowOf(w1, "CAM2")?.personnelCmaCost, CENT),
    { swiezy: rowOf(w1, "SWIEZY")?.personnelCmaCost, cam2: rowOf(w1, "CAM2")?.personnelCmaCost });
  ok("okno 12 mies.: obiekt podłączony 2 mies. temu NIE dzieli kosztu sprzed roku",
    rowOf(w12, "CAM2")?.personnelCmaCost > 0 &&
      rowOf(w12, "SWIEZY")?.personnelCmaCost < rowOf(w12, "CAM2")?.personnelCmaCost - 0.01,
    { swiezy: rowOf(w12, "SWIEZY")?.personnelCmaCost, cam2: rowOf(w12, "CAM2")?.personnelCmaCost });
  /*
   * Odwrotny kierunek tej samej reguły: obiekt, którego usługa skończyła się
   * z końcem zeszłego miesiąca, NIE MA dziś ani jednej aktywnej usługi (flagi
   * zgaszone, zero jednostek na dziś) — a mimo to dostaje udział w koszcie
   * centrum za miesiąc, w którym centrum go jeszcze dozorowało. Przy mianowniku
   * z „dzisiejszego stanu usług" jego udział wynosiłby zero, a koszt tamtego
   * miesiąca rozpłynąłby się po obiektach, które go nie wygenerowały.
   */
  ok("Obiekt z usługą zakończoną w zeszłym miesiącu dostaje udział ZA TAMTEN miesiąc",
    rowOf(w1, "ZAKONCZONY")?.services.cameras === false &&
      rowOf(w1, "ZAKONCZONY")?.serviceUnits === 0 &&
      rowOf(w1, "ZAKONCZONY")?.personnelCmaCost > 0,
    rowOf(w1, "ZAKONCZONY"));

  /*
   * Odcisk cache'u musi obejmować `object_services`: przesunięcie STARTU okresu
   * nie zmienia w tabeli `objects` ANI JEDNEJ kolumny (usługa nadal trwa), więc
   * bez tych liczników admin poprawiłby datę i zobaczył stary koszt.
   */
  const freshPeriod = db
    .select({ id: schema.objectServices.id })
    .from(schema.objectServices)
    .where(eq(schema.objectServices.objectId, oFresh.id))
    .all()[0];
  db.update(schema.objectServices)
    .set({ startDate: SERVICE_START, updatedAt: new Date().toISOString() })
    .where(eq(schema.objectServices.id, freshPeriod.id))
    .run();
  const w12moved = await wide(12); // BEZ clearPersonnelCostCache()
  ok("Przesunięcie startu okresu przelicza udział w CMA bez czyszczenia cache’u",
    rowOf(w12moved, "SWIEZY")?.personnelCmaCost > rowOf(w12, "SWIEZY")?.personnelCmaCost &&
      // Po cofnięciu startu obiekt ma tę samą historię, co CAM2 — i ten sam udział.
      // Porównujemy w RAMACH JEDNEJ odpowiedzi: dołożenie jednostek do dawnych
      // miesięcy obniża udział wszystkim pozostałym, więc kwota CAM2 też się zmienia.
      near(
        rowOf(w12moved, "SWIEZY")?.personnelCmaCost,
        rowOf(w12moved, "CAM2")?.personnelCmaCost,
        CENT
      ),
    {
      przed: rowOf(w12, "SWIEZY")?.personnelCmaCost,
      po: rowOf(w12moved, "SWIEZY")?.personnelCmaCost,
      cam2: rowOf(w12moved, "CAM2")?.personnelCmaCost,
    });
  db.update(schema.objectServices)
    .set({ startDate: startedFrom, updatedAt: new Date().toISOString() })
    .where(eq(schema.objectServices.id, freshPeriod.id))
    .run();
  clearPersonnelCostCache();

  /* --- „Kończące się" obiekty (endingSoon) --------------------------------
   * Predykat mieszka w src/lib/object-services.ts i jest JEDEN dla listy obiektów
   * (SQL) i dla analityki (JS) — kafelek linkuje do listy z tym samym horyzontem,
   * więc dwie różne liczby byłyby widoczne od razu.
   */
  /*
   * SZACOWANY — okres, którego data startu została ZGADNIĘTA: backfill migracji
   * 0084 wpisał datę założenia kartoteki, a 0087 oznaczył ją `start_estimated`.
   * Data wypada w BIEŻĄCYM miesiącu, więc bez flagi obiekt zameldowałby się
   * w serii czasowej jako świeże pozyskanie — dokładnie ten artefakt (147 sztuk
   * jednego dnia), przez który flaga powstała.
   *
   * Usługa to OFI, bo jako jedyna nie ma wagi w mianowniku kosztu centrum
   * monitorowania: fikstura ma sprawdzać serię czasową, a nie przesuwać udziały
   * policzone w asercjach wyżej.
   */
  const mNow = monthAt(0);
  const mNowBounds = monthBounds(mNow.year, mNow.month);
  const estimatedFrom = mNowBounds.from;
  cmaObj("SZACOWANY", { hasOfi: true }, { startDate: estimatedFrom, startEstimated: true });

  const view90 = await call("/obiekty?scope=all&limit=5000");
  const view365 = await call("/obiekty?scope=all&limit=5000&horizonDays=365");
  /** Niezależna implementacja reguły — celowo napisana tu od zera, nie zaimportowana. */
  const endingLocal = (v: any, days: number) => {
    const limit = isoPlusDays(TODAY, days);
    return v.rows.filter((r: any) => {
      if (r.expectedEndDate && r.expectedEndDate <= limit) return true;
      const live = (r.servicePeriods ?? []).filter((p: any) => !p.endDate || p.endDate >= TODAY);
      return live.length > 0 && live.every((p: any) => p.endDate && p.endDate <= limit);
    });
  };
  const local90 = endingLocal(view90, 90);
  const named = (list: any[], n: string) => list.some((r) => r.name === `${PREFIX}${n}`);

  ok("Wiersz analityki niesie okresy usług i przewidywane zakończenie",
    Array.isArray(rowOf(view90, "CAM2")?.servicePeriods) &&
      rowOf(view90, "CAM2").servicePeriods.length === 1 &&
      rowOf(view90, "CAM2").servicePeriods[0].service === "kamery" &&
      rowOf(view90, "KONCZY")?.expectedEndDate === isoPlusDays(TODAY, 30),
    { okresy: rowOf(view90, "CAM2")?.servicePeriods, koniec: rowOf(view90, "KONCZY")?.expectedEndDate });
  ok("endingSoon: domyślny horyzont to 90 dni", view90.endingSoon?.horizonDays === 90, view90.endingSoon);
  ok("endingSoon: licznik i przychód zagrożony zgodne z wierszami odpowiedzi",
    view90.endingSoon.count === local90.length &&
      near(view90.endingSoon.revenue, local90.reduce((s: number, r: any) => s + r.revenue, 0), 0.011),
    { api: view90.endingSoon, lokalnie: local90.length });
  ok("Przewidywane zakończenie za 30 dni → obiekt się kończy",
    named(local90, "KONCZY"), local90.map((r: any) => r.name).slice(0, 5));
  ok("Okres kończący się za 200 dni: poza horyzontem 90, w horyzoncie 365",
    !named(local90, "DLUGI") && named(endingLocal(view365, 365), "DLUGI") &&
      view365.endingSoon.count > view90.endingSoon.count,
    { h90: view90.endingSoon.count, h365: view365.endingSoon.count });
  ok("Obiekt z WSZYSTKIMI okresami zakończonymi już się nie „kończy”",
    !named(local90, "ZAKONCZONY") && !named(endingLocal(view365, 365), "ZAKONCZONY"));

  // Ta sama definicja po obu stronach: lista obiektów liczy predykat w SQL-u.
  const listRes = await objectsApp.request("/?pageSize=1");
  const list = (await listRes.json()) as any;
  ok("Lista obiektów i analityka liczą „kończące się” tak samo",
    list.endingSoonDays === 90 &&
      list.endingSoonCount === view90.endingSoon.count &&
      near(list.endingSoonRevenue, view90.endingSoon.revenue, 0.011),
    { lista: { count: list.endingSoonCount, revenue: list.endingSoonRevenue }, analityka: view90.endingSoon });

  /* --- Seria czasowa usług (timeline) -------------------------------------
   * 12 miesięcy wstecz WŁĄCZNIE z bieżącym, liczone z okresów, ale kwotami
   * bieżącymi (historii cen kartoteka nie ma). Asercje porównują agregaty API
   * z niezależnym przeliczeniem po tych samych wierszach odpowiedzi.
   */
  const tl = view90.timeline as any[];
  const ym = (m: MonthKey) => `${m.year}-${String(m.month).padStart(2, "0")}`;
  ok("timeline: 12 punktów, po jednym na miesiąc, ostatni to miesiąc bieżący",
    tl?.length === 12 &&
      tl[11].month === ym(monthAt(0)) &&
      tl[0].month === ym(monthAt(-11)) &&
      new Set(tl.map((p) => p.month)).size === 12,
    tl?.map((p) => p.month));
  ok("timeline: wszystkie wiersze zakresu są w odpowiedzi (agregaty da się sprawdzić)",
    view90.rows.length === view90.totals.objects,
    { rows: view90.rows.length, objects: view90.totals.objects });

  const point = (m: MonthKey) => tl.find((p) => p.month === ym(m));
  /** Przeliczenie punktu serii wprost z wierszy — reguła napisana tu od zera. */
  const expectPoint = (m: MonthKey) => {
    const { from, to } = monthBounds(m.year, m.month);
    let activeObjects = 0;
    let started = 0;
    let startedEstimated = 0;
    let ended = 0;
    let revenue = 0;
    let kamery = 0;
    for (const r of view90.rows as any[]) {
      const periods = r.servicePeriods ?? [];
      if (periods.length === 0) {
        // D3: obiekt bez okresów liczy się jako aktywny w każdym miesiącu.
        activeObjects += 1;
        revenue += r.revenue;
        if (r.services.cameras) kamery += r.services.cameraCount ?? 0;
        continue;
      }
      for (const p of periods) {
        // Data szacowana to nie rozpoczęcie usługi — liczy się osobno.
        if (p.startDate >= from && p.startDate <= to) {
          if (p.startEstimated) startedEstimated += 1;
          else started += 1;
        }
        if (p.endDate && p.endDate >= from && p.endDate <= to) ended += 1;
      }
      const live = periods.filter(
        (p: any) => p.startDate <= to && (!p.endDate || p.endDate >= from)
      );
      if (live.length === 0) continue;
      activeObjects += 1;
      revenue += r.revenue;
      const cams = live.filter((p: any) => p.service === "kamery");
      if (cams.length > 0 && cams.every((p: any) => p.cameraCount != null)) {
        kamery += cams.reduce((s: number, p: any) => s + p.cameraCount, 0);
      }
    }
    return { activeObjects, started, startedEstimated, ended, revenue, kamery };
  };

  const samples: MonthKey[] = [monthAt(0), monthAt(-1), monthAt(-2), monthAt(-11)];
  for (const m of samples) {
    const got = point(m);
    const want = expectPoint(m);
    ok(`timeline ${ym(m)}: aktywne obiekty, rozpoczęcia, zakończenia, kamery i przychód`,
      got?.activeObjects === want.activeObjects &&
        got?.started === want.started &&
        got?.startedEstimated === want.startedEstimated &&
        got?.ended === want.ended &&
        got?.activeUnits.kamery === want.kamery &&
        near(got?.revenue, want.revenue, 0.011),
      { api: got, oczekiwane: want });
  }
  ok("timeline: usługa rozpoczęta 2 mies. temu wchodzi do `started` swojego miesiąca",
    (point(monthAt(-2))?.started ?? 0) >= 1 &&
      expectPoint(monthAt(-2)).started === point(monthAt(-2))?.started,
    point(monthAt(-2)));

  /* --- Daty startu SZACOWANE (backfill 0084 → flaga z 0087) ----------------
   * Wiersz z `startEstimated` mówi „usługa jest, ale nie wiemy od kiedy". Nie
   * może więc udawać pozyskania w miesiącu importu — ale nie wolno go też
   * wyrzucić z aktywnych, bo obiekt realnie jest obsługiwany.
   */
  const estRow = rowOf(view90, "SZACOWANY");
  const estPeriods = (estRow?.servicePeriods ?? []) as any[];
  const nowPoint = point(monthAt(0));
  ok("API zwraca `startEstimated` w okresach usług",
    estPeriods.length === 1 && estPeriods[0].startEstimated === true &&
      estPeriods[0].startDate === estimatedFrom,
    estPeriods);
  // Ile okresów o dacie szacowanej wypada w bieżącym miesiącu — liczone tu od zera.
  const estStartsNow = (view90.rows as any[]).reduce(
    (n: number, r: any) =>
      n + ((r.servicePeriods ?? []) as any[]).filter(
        (p) => p.startEstimated && p.startDate >= mNowBounds.from && p.startDate <= mNowBounds.to
      ).length,
    0
  );
  ok("timeline: okres z datą szacowaną NIE wchodzi do `started`",
    estStartsNow >= 1 && nowPoint?.started === expectPoint(monthAt(0)).started &&
      nowPoint?.started === (view90.rows as any[]).reduce(
        (n: number, r: any) =>
          n + ((r.servicePeriods ?? []) as any[]).filter(
            (p) => !p.startEstimated && p.startDate >= mNowBounds.from && p.startDate <= mNowBounds.to
          ).length,
        0
      ),
    { punkt: nowPoint, szacowane: estStartsNow });
  ok("timeline: pominięte rozpoczęcia są policzone w `startedEstimated`",
    nowPoint?.startedEstimated === estStartsNow && estStartsNow > 0,
    { punkt: nowPoint, szacowane: estStartsNow });
  // Aktywność liczymy bez tego obiektu i sprawdzamy, że API ma o jeden więcej:
  // usługa z nieznanym startem jest usługą świadczoną, nie duchem.
  const activeNowWithoutEst = (view90.rows as any[]).filter((r: any) => {
    if (r.name === `${PREFIX}SZACOWANY`) return false;
    const periods = (r.servicePeriods ?? []) as any[];
    if (periods.length === 0) return true;
    return periods.some(
      (p) => p.startDate <= mNowBounds.to && (!p.endDate || p.endDate >= mNowBounds.from)
    );
  }).length;
  ok("timeline: obiekt z datą szacowaną nadal liczy się do `activeObjects`",
    nowPoint?.activeObjects === activeNowWithoutEst + 1,
    { api: nowPoint?.activeObjects, bezSzacowanego: activeNowWithoutEst });
  const freshRow = rowOf(view90, "SWIEZY");
  const freshActiveIn = (offset: number) => {
    const m = monthAt(offset);
    const { from, to } = monthBounds(m.year, m.month);
    return (freshRow.servicePeriods as any[]).some(
      (p) => p.startDate <= to && (!p.endDate || p.endDate >= from)
    );
  };
  // Punkty serii są już sprawdzone co do liczby (asercje wyżej), więc wystarczy
  // pokazać, że TEN obiekt wchodzi dokładnie do trzech ostatnich miesięcy.
  ok("timeline: obiekt z usługą od 2 mies. jest aktywny w 3 ostatnich miesiącach, wcześniej nie",
    freshActiveIn(0) && freshActiveIn(-1) && freshActiveIn(-2) && !freshActiveIn(-3),
    { start: startedFrom, okresy: freshRow?.servicePeriods });
  ok("timeline: usługa zamknięta w zeszłym miesiącu wchodzi do `ended` tamtego miesiąca",
    (point(mPrev)?.ended ?? 0) >= 1 && point(mPrev)?.ended === expectPoint(mPrev).ended,
    point(mPrev));

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
